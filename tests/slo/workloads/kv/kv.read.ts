import { randomInt } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { workerData } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Uint64 } from '@ydbjs/value/primitive'
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
let rps = parseInt(params['rps'] ?? '1000', 10)
let keyspace = parseInt(params['keyspace'] ?? '1000', 10)

let ctrl = new AbortController()
let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

// ---- Metrics ---------------------------------------------------------------
let meter = meterProvider.getMeter('kv-read-meter')

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

registerLatencyGauges(meter, latency, { operation_type: 'read', operation_status: 'success' })

// ---- Operation -------------------------------------------------------------
let sql = query(driver)
async function readOp(): Promise<void> {
	let id = new Uint64(BigInt(randomInt(keyspace)))
	let start = performance.now()
	let retries = 0

	let opType = 'read' as const
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
		await sql`SELECT * FROM test WHERE id = ${id} AND hash = Digest::NumericHash(${id})`
			.idempotent(true)
			.isolation('onlineReadOnly')
			.signal(ctrl.signal)
			.on('retry', () => retries++)

		opStatus = 'success'
		latency.recordValue(Math.round((performance.now() - start) * 1000))
	} catch (err) {
		if (ctrl.signal.aborted) return
		console.error(err)
	}
}

console.info('running at %d RPS (keyspace=%d)', rps, keyspace)

{
	using _ = abortOnStop(ctrl)
	await runPaced(rps, readOp, ctrl.signal)
}

// ---- Shutdown --------------------------------------------------------------
try {
	await meterProvider.forceFlush()
} catch (err) {
	console.error('[kv.read] meter flush failed:', err)
}

try {
	await meterProvider.shutdown()
} catch (err) {
	console.error('[kv.read] meter shutdown failed:', err)
}

try {
	driver.close()
} catch (err) {
	console.error('[kv.read] driver close failed:', err)
}

process.exit(0)
