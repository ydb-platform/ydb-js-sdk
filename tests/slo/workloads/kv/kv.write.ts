import { randomInt, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { workerData } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Timestamp, Uint64 } from '@ydbjs/value/primitive'
import * as hdr from 'hdr-histogram-js'

import { installSafetyHandlers } from '../../lib/safety.ts'
import {
	type FinOpAttrs,
	type OpAttrs,
	meterProvider,
	registerLatencyGauges,
} from '../../lib/telemetry.ts'
import { type WorkerData, abortOnStop, runPaced } from '../../lib/worker-api.ts'

installSafetyHandlers()

let { name, params } = workerData as WorkerData
let rps = parseInt(params['rps'] ?? '100', 10)
let timeout = parseInt(params['timeout'] ?? '100', 10)
let keyspace = parseInt(params['keyspace'] ?? '1000', 10)

let ctrl = new AbortController()
let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()
let sql = query(driver)

// ---- Metrics ---------------------------------------------------------------
let meter = meterProvider.getMeter('kv-write-meter')

let latency = hdr.build({ highestTrackableValue: 60_000_000, numberOfSignificantValueDigits: 3 })

let sdk_operations = meter.createCounter<FinOpAttrs>('sdk_operations_total', {
	valueType: ValueType.INT,
	description: 'Total number of SDK operations',
})

let sdk_retry_attempts = meter.createCounter<OpAttrs>('sdk_retry_attempts_total', {
	valueType: ValueType.INT,
	description: 'Total number of SDK retry attempts',
})

let sdk_pending_operations = meter.createUpDownCounter<OpAttrs>('sdk_pending_operations', {
	valueType: ValueType.INT,
	description: 'Number of pending SDK operations',
})

meter
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

registerLatencyGauges(meter, latency, { operation_type: 'write', operation_status: 'success' })

// ---- Operation -------------------------------------------------------------
async function writeOp(): Promise<void> {
	let id = new Uint64(BigInt(randomInt(keyspace)))
	let start = performance.now()
	let retries = 0

	let opType = 'write' as const
	let opStatus: 'success' | 'error' = 'error'

	sdk_pending_operations.add(1, { operation_type: opType })

	using _ = {
		[Symbol.dispose]() {
			sdk_pending_operations.add(-1, { operation_type: opType })

			if (ctrl.signal.aborted) return

			sdk_operations.add(1, { operation_type: opType, operation_status: opStatus })
			sdk_retry_attempts.add(1 + retries, { operation_type: opType })
		},
	}

	try {
		await sql`UPSERT INTO test (hash, id, payload_str, payload_double, payload_timestamp) VALUES (
			Digest::NumericHash(${id}),
			${id},
			${randomUUID()},
			${Math.random()},
			${new Timestamp(new Date())}
		);`
			.idempotent(true)
			.isolation('serializableReadWrite')
			.timeout(timeout)
			.signal(ctrl.signal)
			.on('retry', () => retries++)

		opStatus = 'success'
		latency.recordValue(Math.round((performance.now() - start) * 1000))
	} catch (err) {
		if (ctrl.signal.aborted) return
		if (err instanceof Error && err.name === 'TimeoutError') return
		console.error(err)
	}
}

console.info('running at %d RPS (keyspace=%d)', rps, keyspace)

{
	using _ = abortOnStop(ctrl)
	await runPaced(rps, writeOp, ctrl.signal)
}

// ---- Shutdown --------------------------------------------------------------
try {
	await meterProvider.forceFlush()
} catch (err) {
	console.error('[kv.write] meter flush failed:', err)
}

try {
	await meterProvider.shutdown()
} catch (err) {
	console.error('[kv.write] meter shutdown failed:', err)
}

try {
	driver.close()
} catch (err) {
	console.error('[kv.write] driver close failed:', err)
}

process.exit(0)
