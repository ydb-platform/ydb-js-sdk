import { channel } from 'node:diagnostics_channel'
import { parentPort, workerData } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { GZIP_CODEC, RAW_CODEC, ZSTD_CODEC } from '@ydbjs/topic/codec'
import { type TopicWriter, createTopicWriter } from '@ydbjs/topic/writer'
import * as hdr from 'hdr-histogram-js'

import { RateLimiter } from '../../lib/rate-limiter.ts'
import { installSafetyHandlers } from '../../lib/safety.ts'
import { meterProvider, registerLatencyGauges } from '../../lib/telemetry.ts'
import { TopicOracle } from '../../lib/topic-oracle.ts'
import type { TopicWorkerControl, TopicWorkerData } from '../../lib/worker-api.ts'

let options = workerData as TopicWorkerData
let { name, topic, partitions, rps, codec, drainTimeoutMs, stallTimeoutMs } = options
let oracle = new TopicOracle(options)
let accepted = Array<number>(partitions).fill(0)
let acknowledged = [...accepted]
let producing = new AbortController()
let io = new AbortController()
let failure: Error | undefined
let reconnects = 0
let activeFlushes = new Set<string>()
let fail = (error: unknown) => {
	failure ??= error instanceof Error ? error : new Error(String(error))
	producing.abort(failure)
	io.abort(failure)
	parentPort!.postMessage({ type: 'result', success: false, error: failure.message })
}
installSafetyHandlers('log', (_, error) => fail(error))
parentPort!.on('message', (message: TopicWorkerControl) => {
	if (message.type === 'stop') producing.abort()
})
let checkpoint = () => ({ accepted: [...accepted], acknowledged: [...acknowledged] })
let report = () => parentPort!.postMessage({ type: 'checkpoint', checkpoint: checkpoint() })
let meter = meterProvider.getMeter('topic-write-meter')
let operations = meter.createCounter('sdk_operations_total')
let attempts = meter.createCounter('sdk_retry_attempts_total')
let latency = hdr.build({ highestTrackableValue: 600_000_000, numberOfSignificantValueDigits: 3 })
registerLatencyGauges(meter, latency, { operation_type: 'write', operation_status: 'success' })
meter
	.createObservableGauge('sdk_memory_usage', { unit: 'bytes', valueType: ValueType.INT })
	.addCallback((r) => {
		let memory = process.memoryUsage()
		for (let type of ['rss', 'heapUsed', 'external', 'arrayBuffers'] as const)
			r.observe(memory[type], { worker: name, type })
	})
let barrier = Promise.resolve()
let barrierPending = false
let progress: ReturnType<typeof setInterval> | undefined
let startup = setTimeout(() => fail(new Error('Writer startup timed out')), 60_000)
try {
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	await driver.ready(io.signal)
	let codecs = [RAW_CODEC, GZIP_CODEC, ZSTD_CODEC]
	let writers: TopicWriter[] = []
	let reconnect = channel('ydb:topic.writer.reconnecting')
	let onReconnect = (event: unknown) => {
		let info = event as { driver: unknown; producer: string }
		if (info.driver !== driver.identity) return
		reconnects++
		if (activeFlushes.has(info.producer)) attempts.add(1, { operation_type: 'write' })
	}
	reconnect.subscribe(onReconnect)
	using _ = {
		[Symbol.dispose]() {
			reconnect.unsubscribe(onReconnect)
			for (let writer of writers) writer.destroy()
		},
	}
	for (let partition = 0; partition < partitions; partition++) {
		writers.push(
			createTopicWriter(driver, {
				topic,
				producer: oracle.producerId(partition),
				partitionId: BigInt(partition),
				codec:
					codec === 'mixed'
						? codecs[partition % 3]!
						: { raw: RAW_CODEC, gzip: GZIP_CODEC, zstd: ZSTD_CODEC }[codec]!,
				gracefulShutdownTimeoutMs: drainTimeoutMs,
			})
		)
	}
	let flush = async () => {
		let targets = [...accepted]
		report()
		await Promise.all(
			writers.map(async (writer, partition) => {
				if (targets[partition] === 0) return
				let producer = oracle.producerId(partition)
				let start = performance.now()
				activeFlushes.add(producer)
				attempts.add(1, { operation_type: 'write' })
				try {
					await writer.flush(io.signal)
					acknowledged[partition] = targets[partition]!
					operations.add(1, { operation_type: 'write', operation_status: 'success' })
					latency.recordValue(Math.round((performance.now() - start) * 1000))
				} catch (error) {
					operations.add(1, { operation_type: 'write', operation_status: 'error' })
					throw error
				} finally {
					activeFlushes.delete(producer)
				}
			})
		)
		report()
	}
	let previous = [...acknowledged]
	let lastAck = Array<number>(partitions).fill(Date.now())
	progress = setInterval(() => {
		report()
		for (let partition = 0; partition < partitions; partition++) {
			if (
				acknowledged[partition]! > previous[partition]! ||
				accepted[partition] === acknowledged[partition]
			)
				lastAck[partition] = Date.now()
			if (Date.now() - lastAck[partition]! > stallTimeoutMs)
				fail(new Error(`Writer partition ${partition} acknowledgment progress stalled`))
		}
		previous = [...acknowledged]
		if (barrierPending || io.signal.aborted) return
		barrierPending = true
		barrier = flush()
			.catch(fail)
			.finally(() => {
				barrierPending = false
			})
	}, 1000)
	clearTimeout(startup)
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
		writers[partition]!.write(oracle.createPayload(partition, sequence))
		accepted[partition] = sequence
	}
	clearInterval(progress)
	await barrier
	io.signal.throwIfAborted()
	await flush()
	await Promise.all(writers.map((writer) => writer.close(io.signal)))
} catch (error) {
	fail(error)
} finally {
	clearTimeout(startup)
	clearInterval(progress)
	io.abort()
	await barrier
}
try {
	await meterProvider.forceFlush()
	await meterProvider.shutdown()
} catch (error) {
	console.error('[topic.write] metric flush failed:', error)
}
parentPort!.postMessage({
	type: 'result',
	success: !failure,
	error: failure?.message,
	checkpoint: checkpoint(),
	reconnects,
})
process.exit(failure ? 1 : 0)
