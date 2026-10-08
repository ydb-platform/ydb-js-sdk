import { randomUUID } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parentPort, workerData } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'
import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { GZIP_CODEC, RAW_CODEC, ZSTD_CODEC } from '@ydbjs/topic/codec'
import { type TopicPartitionSession, createTopicReader } from '@ydbjs/topic/reader'
import { type TopicWriter, createTopicWriter } from '@ydbjs/topic/writer'
import type { TopicMessage } from '@ydbjs/topic/message'
import * as hdr from 'hdr-histogram-js'

import { RateLimiter } from '../../lib/rate-limiter.ts'
import { isPartitionRevokedError } from '../../lib/topic-errors.ts'
import { installSafetyHandlers } from '../../lib/safety.ts'
import { meterProvider, registerLatencyGauges } from '../../lib/telemetry.ts'
import { type TopicObservation, TopicOracle } from '../../lib/topic-oracle.ts'
import { type WorkerData, abortOnStop } from '../../lib/worker-api.ts'

let { name, params } = workerData as WorkerData
let integer = function integer(key: string, fallback: number, min: number, max: number): number {
	let value = Number(params[key] ?? fallback)
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new RangeError(`${key} must be an integer between ${min} and ${max}`)
	}
	return value
}
let partitions = integer('partitions', 10, 1, 100)
let messageBytes = integer('size', 1024, 64, 8 * 1024 * 1024)
let rps = integer('rps', 100, 1, 100_000)
let drainTimeoutMs = integer('drainTimeoutMs', 120_000, 1, 600_000)
let stallTimeoutMs = integer('stallTimeoutMs', 120_000, 1, 600_000)
let runId = randomUUID()
let topic = `${params['topic'] ?? 'slo-topic'}-${runId}`
let consumer = 'slo-consumer'
let codec = params['codec'] ?? 'mixed'
let codecs = { raw: RAW_CODEC, gzip: GZIP_CODEC, zstd: ZSTD_CODEC }
if (codec !== 'mixed' && !Object.hasOwn(codecs, codec))
	throw new Error(`Unsupported codec: ${codec}`)
let oracle = new TopicOracle({ runId, partitions, messageBytes })
let producing = new AbortController()
let reading = new AbortController()
let io = new AbortController()
let startedAt = Date.now()
let phase = 'starting'
let failure: unknown
let reconnects = { writer: 0, reader: 0 }
let activeFlushes = new Set<string>()
let activeRead = false
let abortReader: (reason: unknown) => void = () => {}

let fail = function fail(error: unknown): void {
	if (failure !== undefined) return
	failure = error
	let message = error instanceof Error ? error.message : String(error)
	oracle.fail(`${phase}: ${message}`)
	console.error('[topic.run] FAIL:', error)
	parentPort?.postMessage({ type: 'workload-result', success: false, error: message })
	producing.abort(error)
	reading.abort(error)
	io.abort(error)
	abortReader(error)
}
installSafetyHandlers('log', (_, error) => fail(error))

let meter = meterProvider.getMeter('topic-integrity')
let operations = meter.createCounter('sdk_operations_total')
let attempts = meter.createCounter('sdk_retry_attempts_total')
let latency = {
	write: hdr.build({ highestTrackableValue: 600_000_000, numberOfSignificantValueDigits: 3 }),
	read: hdr.build({ highestTrackableValue: 600_000_000, numberOfSignificantValueDigits: 3 }),
}
for (let operation_type of ['write', 'read'] as const) {
	registerLatencyGauges(meter, latency[operation_type], {
		operation_type,
		operation_status: 'success',
	})
}
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

using _ = abortOnStop(producing)
let progress: ReturnType<typeof setInterval> | undefined
let flushTimer: ReturnType<typeof setInterval> | undefined
let drainTimer: ReturnType<typeof setTimeout> | undefined
let startupTimer = setTimeout(() => fail(new Error('Topic startup timed out')), 60_000)
let readerTask = Promise.resolve()
let barrier = Promise.resolve()
let barrierPending = false
let expectedReadStop = false

try {
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	await driver.ready(io.signal)
	let service = driver.createClient(TopicServiceDefinition)
	let created = await service.createTopic(
		create(CreateTopicRequestSchema, {
			path: topic,
			partitioningSettings: {
				minActivePartitions: BigInt(partitions),
				maxActivePartitions: BigInt(partitions),
			},
			supportedCodecs: { codecs: [Codec.RAW, Codec.GZIP, Codec.ZSTD] },
			consumers: [{ name: consumer }],
		}),
		{ signal: io.signal }
	)
	if (!created.operation?.ready || created.operation.status !== StatusIds_StatusCode.SUCCESS) {
		throw new Error(
			`Topic creation failed: ${created.operation?.status}, ${JSON.stringify(created.operation?.issues)}`
		)
	}
	let readerReconnect = channel('ydb:topic.reader.reconnecting')
	let writerReconnect = channel('ydb:topic.writer.reconnecting')
	let onReaderReconnect = (event: unknown) => {
		if ((event as { driver: unknown }).driver !== driver.identity) return
		reconnects.reader++
		if (activeRead) attempts.add(1, { operation_type: 'read' })
	}
	let onWriterReconnect = (event: unknown) => {
		let info = event as { driver: unknown; producer: string }
		if (info.driver !== driver.identity) return
		reconnects.writer++
		if (activeFlushes.has(info.producer)) attempts.add(1, { operation_type: 'write' })
	}
	readerReconnect.subscribe(onReaderReconnect)
	writerReconnect.subscribe(onWriterReconnect)
	let writers: TopicWriter[] = []
	// oxlint-disable-next-line no-shadow
	using _ = {
		[Symbol.dispose]() {
			readerReconnect.unsubscribe(onReaderReconnect)
			writerReconnect.unsubscribe(onWriterReconnect)
			for (let writer of writers) writer.destroy()
		},
	}
	let accepted = Array<number>(partitions).fill(0)
	for (let partition = 0; partition < partitions; partition++)
		writers.push(
			createTopicWriter(driver, {
				topic,
				producer: oracle.producerId(partition),
				partitionId: BigInt(partition),
				codec:
					codec === 'mixed'
						? [RAW_CODEC, GZIP_CODEC, ZSTD_CODEC][partition % 3]!
						: codecs[codec as keyof typeof codecs],
				gracefulShutdownTimeoutMs: drainTimeoutMs,
			})
		)
	let confirm = (partitionId: bigint, offset: bigint) => {
		try {
			oracle.confirmCommittedOffset(Number(partitionId), offset)
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
	abortReader = (reason) => reader.destroy(reason)
	let flush = async function flush(): Promise<void> {
		let targets = [...accepted]
		await Promise.all(
			writers.map(async (writer, partition) => {
				if (targets[partition] === 0) return
				let producer = oracle.producerId(partition)
				let start = performance.now()
				activeFlushes.add(producer)
				attempts.add(1, { operation_type: 'write' })
				try {
					await writer.flush(io.signal)
					oracle.acknowledge(partition, targets[partition]!)
					operations.add(1, { operation_type: 'write', operation_status: 'success' })
					latency.write.recordValue(Math.round((performance.now() - start) * 1000))
				} catch (error) {
					operations.add(1, { operation_type: 'write', operation_status: 'error' })
					throw error
				} finally {
					activeFlushes.delete(producer)
				}
			})
		)
	}
	readerTask = (async () => {
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
				if (committedBatch)
					latency.read.recordValue(Math.round((performance.now() - start) * 1000))
				activeRead = false
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
	})().catch(fail)
	let previous = oracle.snapshot().producers
	let lastAck = Array<number>(partitions).fill(Date.now())
	let lastCommit = [...lastAck]
	let ticks = 0
	progress = setInterval(() => {
		let snapshot = oracle.snapshot()
		let now = Date.now()
		for (let producer of snapshot.producers) {
			let p = producer.partition
			if (
				producer.acknowledged > previous[p]!.acknowledged ||
				producer.pending.unacknowledged === 0
			)
				lastAck[p] = now
			if (
				producer.committed > previous[p]!.committed ||
				(producer.pending.acknowledgedUndelivered === 0 &&
					producer.pending.uncommitted === 0)
			)
				lastCommit[p] = now
			if (now - lastAck[p]! > stallTimeoutMs)
				fail(new Error(`Writer partition ${p} acknowledgment progress stalled`))
			if (now - lastCommit[p]! > stallTimeoutMs)
				fail(new Error(`Reader partition ${p} delivery/commit progress stalled`))
		}
		previous = snapshot.producers
		if (++ticks % 10 === 0)
			console.info(
				'[topic.progress] %s',
				JSON.stringify({ phase, ...snapshot.totals, pending: snapshot.pending, reconnects })
			)
	}, 1000)
	flushTimer = setInterval(() => {
		if (barrierPending || io.signal.aborted) return
		barrierPending = true
		barrier = flush()
			.catch(fail)
			.finally(() => {
				barrierPending = false
			})
	}, 1000)
	clearTimeout(startupTimer)
	phase = 'producing'
	console.info(
		'[topic.run] %s',
		JSON.stringify({
			runId,
			topic,
			partitions,
			rps,
			messageBytes,
			codec,
			drainTimeoutMs,
			stallTimeoutMs,
		})
	)
	try {
		let limiter = new RateLimiter(rps)
		let round = 0
		while (!producing.signal.aborted) {
			try {
				// oxlint-disable-next-line no-await-in-loop
				await limiter.wait(producing.signal)
			} catch (error) {
				if (producing.signal.aborted) break
				throw error
			}
			let partition = round++ % partitions
			let sequence = accepted[partition]! + 1
			let payload = oracle.createPayload(partition, sequence)
			writers[partition]!.write(payload)
			oracle.accept(partition, sequence)
			accepted[partition] = sequence
		}
		clearInterval(flushTimer)
		phase = 'draining'
		drainTimer = setTimeout(
			() => fail(new Error('Topic flush/read/commit drain timed out')),
			drainTimeoutMs
		)
		await barrier
		io.signal.throwIfAborted()
		await flush()
		while (!oracle.complete) {
			// oxlint-disable-next-line no-await-in-loop
			await sleep(25, undefined, { signal: io.signal })
		}
		expectedReadStop = true
		reading.abort()
		await readerTask
		await Promise.all(writers.map((writer) => writer.close(io.signal)))
		await reader.close()
		io.signal.throwIfAborted()
		phase = 'complete'
		let dropped = await service.dropTopic(create(DropTopicRequestSchema, { path: topic }), {
			signal: io.signal,
		})
		if (!dropped.operation?.ready || dropped.operation.status !== StatusIds_StatusCode.SUCCESS)
			throw new Error(`Topic cleanup failed: ${dropped.operation?.status}`)
	} catch (error) {
		fail(error)
	} finally {
		clearInterval(flushTimer)
		clearInterval(progress)
		clearTimeout(drainTimer)
		reading.abort()
		io.abort()
		if (failure !== undefined) reader.destroy(failure)
		await readerTask
		await barrier
	}
} catch (error) {
	fail(error)
} finally {
	clearTimeout(startupTimer)
}

try {
	await meterProvider.forceFlush()
	await meterProvider.shutdown()
} catch (error) {
	console.error('[topic.run] metric flush failed:', error)
}

let summary = {
	...oracle.snapshot(),
	topic,
	codec,
	rps,
	phase,
	startedAt: new Date(startedAt).toISOString(),
	elapsedMs: Date.now() - startedAt,
	reconnects,
}
let success = failure === undefined && summary.complete && phase === 'complete'
console.info('[topic.result] %s', JSON.stringify({ success, ...summary }))
try {
	let resultPath = process.env['TOPIC_RESULT_FILE']
	if (resultPath) {
		await mkdir(dirname(resultPath), { recursive: true })
		await writeFile(
			`${resultPath}.tmp`,
			JSON.stringify({ success, ...summary }, null, 2) + '\n'
		)
		await rename(`${resultPath}.tmp`, resultPath)
	}
} catch (error) {
	success = false
	console.error('[topic.run] cannot save result:', error)
}
success = success && failure === undefined && oracle.complete
parentPort?.postMessage({ type: 'workload-result', success, summary })
process.exit(success ? 0 : 1)
