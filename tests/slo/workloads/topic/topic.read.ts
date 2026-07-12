import { workerData } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { createTopicReader } from '@ydbjs/topic/reader'

import { installSafetyHandlers } from '../../lib/safety.ts'
import { meterProvider } from '../../lib/telemetry.ts'
import { type WorkerData, abortOnStop } from '../../lib/worker-api.ts'

installSafetyHandlers()

let { name, params } = workerData as WorkerData
let topic = params['topic'] ?? 'slo-topic'
let consumer = params['consumer'] ?? 'slo-consumer'

let ctrl = new AbortController()

// Process-memory gauge (same shape as the kv workloads): rss is process-wide,
// heapUsed is this worker's isolate — the long-run leak signal. Op-level metrics
// stay out: the topic chaos signal is binary (ordering either holds or the run fails).
meterProvider
	.getMeter('topic-read-meter')
	.createObservableGauge('sdk_memory_usage', {
		unit: 'bytes',
		valueType: ValueType.INT,
		description: 'Memory usage by the SDK process',
	})
	.addCallback((r) => {
		let usage = process.memoryUsage()
		r.observe(usage.rss, { worker: name, type: 'rss' })
		r.observe(usage.external, { worker: name, type: 'external' })
		r.observe(usage.heapUsed, { worker: name, type: 'heapUsed' })
		r.observe(usage.heapTotal, { worker: name, type: 'heapTotal' })
		r.observe(usage.arrayBuffers, { worker: name, type: 'arrayBuffers' })
	})

// Per-producer expected seqno. The first message seen for a producer sets the
// baseline (the reader may resume mid-stream after a rebalance/restart); every
// later message must be contiguous.
//   seqno == expected → delivered, expected++
//   seqno >  expected → LOST (forward gap)   → exit non-zero, FAILS the run
//   seqno <  expected → duplicate (redelivery of uncommitted after chaos) → fine
// A persistent loss recurs across the stream, so the supervisor's restart cap
// turns it into a failed run; a clean run never sees a gap.
let expected = new Map<string, bigint>()
let delivered = 0
let duplicates = 0

{
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	await driver.ready()
	await using reader = createTopicReader(driver, { topic, consumer })
	using _ = abortOnStop(ctrl)

	try {
		for await (let batch of reader.read({ signal: ctrl.signal })) {
			let lost = 0
			for (let message of batch) {
				let want = expected.get(message.producer)
				if (want === undefined || message.seqNo === want) {
					expected.set(message.producer, message.seqNo + 1n)
					delivered += 1
				} else if (message.seqNo > want) {
					lost += Number(message.seqNo - want)
					expected.set(message.producer, message.seqNo + 1n)
				} else {
					duplicates += 1
				}
			}
			if (lost > 0) {
				console.error('[topic.read] FAIL: %d message(s) lost (forward seqno gap)', lost)
				process.exit(1)
			}
			await reader.commit(batch)
		}
	} catch (err) {
		// The intentional stop aborts read(); anything else is an SDK failure.
		if (!ctrl.signal.aborted) {
			console.error('[topic.read] reader error:', err)
			process.exit(1)
		}
	}
}

console.info('[topic.read] delivered=%d duplicates=%d', delivered, duplicates)
process.exit(0)
