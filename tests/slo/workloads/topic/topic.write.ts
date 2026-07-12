import { workerData } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { createTopicWriter } from '@ydbjs/topic/writer'

import { installSafetyHandlers } from '../../lib/safety.ts'
import { meterProvider } from '../../lib/telemetry.ts'
import { type WorkerData, abortOnStop, runPaced } from '../../lib/worker-api.ts'

installSafetyHandlers()

let { name, params } = workerData as WorkerData
let rps = parseInt(params['rps'] ?? '100', 10)
let topic = params['topic'] ?? 'slo-topic'
let partitions = parseInt(params['partitions'] ?? '10', 10)
let size = parseInt(params['size'] ?? '128', 10)

let ctrl = new AbortController()

// Process-memory gauge (same shape as the kv workloads): rss is process-wide,
// heapUsed is this worker's isolate — the long-run leak signal. Op-level metrics
// stay out: the topic chaos signal is binary (ordering either holds or the run fails).
meterProvider
	.getMeter('topic-write-meter')
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

{
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	await driver.ready()

	// One writer per partition, each a unique producer id pinned to its partition, so
	// every producer emits a single ordered auto-seqno stream on one partition. The
	// reader verifies that stream's contiguity. No op-level telemetry here — the topic
	// chaos signal is binary (see topic.read); metrics are meaningless once ordering
	// breaks. The process-memory gauge above is orthogonal (leak observation).
	let writers = Array.from({ length: partitions }, (_, i) =>
		createTopicWriter(driver, {
			topic,
			producer: `w-${i}`,
			partitionId: BigInt(i),
		})
	)
	// Hard-stop every writer on scope exit, even if runPaced throws.
	using _writers = { [Symbol.dispose]: () => writers.forEach((w) => w.destroy()) }

	let payload = new Uint8Array(size)
	let round = 0

	async function writeOp(): Promise<void> {
		try {
			// write() is fire-and-forget; the writer reconnects transparently under
			// chaos. A throw means it failed FATALLY (didn't survive) — crash so the
			// supervisor restarts us, and a persistent failure exhausts the restart cap.
			writers[round % partitions]!.write(payload)
			round += 1
		} catch (err) {
			if (ctrl.signal.aborted) return
			console.error('[topic.write] fatal write error:', err)
			process.exit(1)
		}
	}

	console.info('[topic.write] %d producers at %d RPS total (topic=%s)', partitions, rps, topic)

	using _ = abortOnStop(ctrl)
	await runPaced(rps, writeOp, ctrl.signal)
}

process.exit(0)
