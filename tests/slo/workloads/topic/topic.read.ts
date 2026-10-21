import { channel } from 'node:diagnostics_channel'
import { parentPort, workerData } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { type TopicPartitionSession, createTopicReader } from '@ydbjs/topic/reader'
import type { TopicMessage } from '@ydbjs/topic/message'
import * as hdr from 'hdr-histogram-js'

import { isPartitionRevokedError } from '../../lib/topic-errors.ts'
import { installSafetyHandlers } from '../../lib/safety.ts'
import { meterProvider, registerLatencyGauges } from '../../lib/telemetry.ts'
import { type TopicObservation, TopicOracle } from '../../lib/topic-oracle.ts'
import type { TopicWorkerControl, TopicWorkerData } from '../../lib/worker-api.ts'

let options = workerData as TopicWorkerData
let { name, topic, consumer, partitions, stallTimeoutMs } = options
let oracle = new TopicOracle(options)
let reading = new AbortController()
let io = new AbortController()
let failure: Error | undefined
let finalCheckpoint = false
let expectedReadStop = false
let activeRead = false
let reconnects = 0
let abortReader: (error: unknown) => void = () => {}
let fail = (error: unknown) => {
	failure ??= error instanceof Error ? error : new Error(String(error))
	oracle.fail(failure.message)
	reading.abort(failure)
	io.abort(failure)
	abortReader(failure)
	parentPort!.postMessage({ type: 'result', success: false, error: failure.message })
}
let finishRead = () => {
	if (!finalCheckpoint) return
	if (oracle.snapshot().producers.some((producer) => producer.delivered > producer.accepted)) {
		fail(new Error('Reader delivered beyond the final writer checkpoint'))
		return
	}
	if (oracle.complete) {
		expectedReadStop = true
		reading.abort()
	}
}
installSafetyHandlers('log', (_, error) => fail(error))
parentPort!.on('message', (message: TopicWorkerControl) => {
	if (message.type !== 'checkpoint') return
	try {
		oracle.updateWriter(message.checkpoint)
		finalCheckpoint ||= message.final
		finishRead()
	} catch (error) {
		fail(error)
	}
})
let meter = meterProvider.getMeter('topic-read-meter')
let operations = meter.createCounter('sdk_operations_total')
let attempts = meter.createCounter('sdk_retry_attempts_total')
let latency = hdr.build({ highestTrackableValue: 600_000_000, numberOfSignificantValueDigits: 3 })
registerLatencyGauges(meter, latency, { operation_type: 'read', operation_status: 'success' })
meter
	.createObservableGauge('sdk_memory_usage', { unit: 'bytes', valueType: ValueType.INT })
	.addCallback((r) => {
		let memory = process.memoryUsage()
		for (let type of ['rss', 'heapUsed', 'external', 'arrayBuffers'] as const)
			r.observe(memory[type], { worker: name, type })
	})
meter.createObservableGauge('sdk_topic_messages', { valueType: ValueType.INT }).addCallback((r) => {
	for (let [state, count] of Object.entries(oracle.snapshot().totals)) r.observe(count, { state })
})
let progress: ReturnType<typeof setInterval> | undefined
let startup = setTimeout(() => fail(new Error('Reader startup timed out')), 60_000)
try {
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	await driver.ready(io.signal)
	let reconnect = channel('ydb:topic.reader.reconnecting')
	let onReconnect = (event: unknown) => {
		if ((event as { driver: unknown }).driver !== driver.identity) return
		reconnects++
		if (activeRead) attempts.add(1, { operation_type: 'read' })
	}
	reconnect.subscribe(onReconnect)
	using _ = {
		[Symbol.dispose]() {
			reconnect.unsubscribe(onReconnect)
		},
	}
	let confirm = (partition: bigint, offset: bigint) => {
		try {
			oracle.confirmCommittedOffset(Number(partition), offset)
			finishRead()
		} catch (error) {
			fail(error)
		}
	}
	using reader = createTopicReader(driver, {
		topic,
		consumer,
		onPartitionSessionStart: async (session, offset) => {
			confirm(session.partitionId, offset)
		},
		onCommittedOffset: (session, offset) => {
			confirm(session.partitionId, offset)
		},
	})
	abortReader = (error) => reader.destroy(error)
	let previous = oracle.snapshot().producers
	let lastCommit = Array<number>(partitions).fill(Date.now())
	let ticks = 0
	progress = setInterval(() => {
		let snapshot = oracle.snapshot()
		for (let producer of snapshot.producers) {
			let partition = producer.partition
			if (
				producer.committed > previous[partition]!.committed ||
				(producer.pending.acknowledgedUndelivered === 0 &&
					producer.pending.uncommitted === 0)
			)
				lastCommit[partition] = Date.now()
			if (Date.now() - lastCommit[partition]! > stallTimeoutMs)
				fail(new Error(`Reader partition ${partition} delivery/commit progress stalled`))
		}
		previous = snapshot.producers
		if (++ticks % 10 === 0)
			console.info(
				'[topic.progress] %s',
				JSON.stringify({ ...snapshot.totals, pending: snapshot.pending, reconnects })
			)
	}, 1000)
	clearTimeout(startup)
	let iterator = reader
		.read({ batchWindowMs: 1000, signal: reading.signal })
		// oxlint-disable-next-line no-unexpected-multiline
		[Symbol.asyncIterator]()
	try {
		while (!reading.signal.aborted) {
			activeRead = true
			attempts.add(1, { operation_type: 'read' })
			let start = performance.now()
			// oxlint-disable-next-line no-await-in-loop
			let result = await iterator.next()
			if (result.done) throw new Error('Reader ended before reconciliation')
			let groups = new Map<
				TopicPartitionSession,
				{ messages: TopicMessage[]; observed: TopicObservation[] }
			>()
			for (let message of result.value) {
				let session = message.partitionSession.deref()
				if (!session || message.offset === undefined)
					throw new Error('Delivered message has no partition or offset')
				let observed = oracle.observe({
					payload: message.payload,
					producer: message.producer,
					partitionId: session.partitionId,
					offset: message.offset,
				})
				let group = groups.get(session)
				if (!group) {
					group = { messages: [], observed: [] }
					groups.set(session, group)
				}
				group.messages.push(message)
				group.observed.push(observed)
			}
			// Concurrent commit calls share a promise. Keep revoked partitions from hiding other ACKs.
			let committedBatch = true
			for (let group of groups.values()) {
				try {
					// oxlint-disable-next-line no-await-in-loop
					await reader.commit(group.messages)
					oracle.commit(group.observed)
				} catch (error) {
					let revoked = isPartitionRevokedError(error)
					if (
						reading.signal.aborted ||
						!revoked ||
						group.messages.every((message) => message.alive)
					)
						throw error
					committedBatch = false
				}
			}
			operations.add(1, {
				operation_type: 'read',
				operation_status: committedBatch ? 'success' : 'error',
			})
			if (committedBatch) latency.recordValue(Math.round((performance.now() - start) * 1000))
			activeRead = false
			finishRead()
		}
	} catch (error) {
		if (!expectedReadStop) {
			operations.add(1, { operation_type: 'read', operation_status: 'error' })
			fail(error)
		}
	} finally {
		activeRead = false
		await iterator.return?.()
	}
	io.signal.throwIfAborted()
	if (!finalCheckpoint || !oracle.complete)
		throw new Error('Reader stopped before final reconciliation')
	await reader.close()
} catch (error) {
	fail(error)
} finally {
	clearTimeout(startup)
	clearInterval(progress)
	reading.abort()
	io.abort()
}
try {
	await meterProvider.forceFlush()
	await meterProvider.shutdown()
} catch (error) {
	console.error('[topic.read] metric flush failed:', error)
}
parentPort!.postMessage({
	type: 'result',
	success: !failure && finalCheckpoint && oracle.complete,
	error: failure?.message,
	summary: oracle.snapshot(),
	reconnects,
})
process.exit(failure ? 1 : 0)
