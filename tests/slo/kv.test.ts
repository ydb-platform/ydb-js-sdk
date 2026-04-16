import { randomInt, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'

import { ValueType } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Timestamp, Uint64 } from '@ydbjs/value/primitive'
import * as hdr from 'hdr-histogram-js'

import { type LatencyAttributes, meterProvider, registerLatencyGauges } from './lib/telemetry.ts'

const READ_RPS = parseInt(process.env['READ_RPS'] || '1000', 10)
const WRITE_RPS = parseInt(process.env['WRITE_RPS'] || '100', 10)
const PREFILL_COUNT = parseInt(process.env['PREFILL_COUNT'] || '1000', 10)
const PREFILL_CONCURRENCY = parseInt(process.env['PREFILL_CONCURRENCY'] || '50', 10)
const DURATION = parseInt(process.env['WORKLOAD_DURATION'] || '60', 10)

let ctrl = new AbortController()
process.on('SIGINT', () => {
	console.error('SIGINT received, stopping workers...')
	ctrl.abort()
})

// ---- Rate limiter ---------------------------------------------------------
// Token-bucket-like "min interval" limiter. Thread-safe by virtue of the JS
// single-threaded event loop: each call reserves its slot synchronously
// (updating `next`) before awaiting the sleep, so N concurrent workers
// fan out onto an evenly-spaced schedule at the configured RPS.
class RateLimiter {
	#next = 0
	readonly #intervalMs: number

	constructor(rps: number) {
		this.#intervalMs = rps > 0 ? 1000 / rps : 0
	}

	async wait(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		if (this.#intervalMs === 0) return

		let now = performance.now()
		let reservedAt: number
		if (now >= this.#next) {
			reservedAt = now
		} else {
			reservedAt = this.#next
		}
		this.#next = reservedAt + this.#intervalMs

		let delay = reservedAt - now
		if (delay > 0) await sleep(delay, undefined, { signal })
	}
}

// ---- Driver ---------------------------------------------------------------
let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

let sql = query(driver)

// ---- Metrics --------------------------------------------------------------
let meter = meterProvider.getMeter('slo-meter')

let latency = {
	read: hdr.build({ highestTrackableValue: 60_000, numberOfSignificantValueDigits: 5 }),
	write: hdr.build({ highestTrackableValue: 60_000, numberOfSignificantValueDigits: 5 }),
}

let sdk_operations_total = meter.createCounter<LatencyAttributes>('sdk_operations_total', {
	valueType: ValueType.INT,
})

let sdk_retry_attempts_total = meter.createCounter<{ operation_type: 'read' | 'write' }>(
	'sdk_retry_attempts_total',
	{ valueType: ValueType.INT }
)

let inFlight = { read: 0, write: 0 }

meter
	.createObservableGauge('sdk_memory_usage', {
		unit: 'bytes',
		valueType: ValueType.INT,
		description: 'Memory usage',
	})
	.addCallback((r) => {
		let usage = process.memoryUsage()
		r.observe(usage.rss, { type: 'rss' })
		r.observe(usage.external, { type: 'external' })
		r.observe(usage.heapUsed, { type: 'heapUsed' })
		r.observe(usage.heapTotal, { type: 'heapTotal' })
		r.observe(usage.arrayBuffers, { type: 'arrayBuffers' })
	})

meter
	.createObservableGauge('sdk_pending_operations', {
		unit: 'operations',
		valueType: ValueType.INT,
		description: 'Pending operations',
	})
	.addCallback((r) => {
		r.observe(inFlight.read, { operation_type: 'read' })
		r.observe(inFlight.write, { operation_type: 'write' })
	})

registerLatencyGauges(meter, latency)

// ---- Operations -----------------------------------------------------------
async function readOp(): Promise<void> {
	let id = new Uint64(BigInt(randomInt(PREFILL_COUNT)))
	let start = performance.now()
	let retries = 0
	let status: 'success' | 'error' | 'aborted' = 'error'
	inFlight.read++

	try {
		await sql`SELECT * FROM test WHERE id = ${id} AND hash = Digest::NumericHash(${id})`
			.idempotent(true)
			.isolation('onlineReadOnly')
			.signal(ctrl.signal)
			.on('retry', () => retries++)
		status = 'success'
		latency.read.recordValue(performance.now() - start)
	} catch (err) {
		if ((err as Error)?.name === 'AbortError' && ctrl.signal.aborted) {
			status = 'aborted'
		} else {
			console.error('read failed:', err)
		}
	} finally {
		inFlight.read--
	}

	if (status === 'aborted') return
	sdk_operations_total.add(1, { operation_type: 'read', operation_status: status })
	sdk_retry_attempts_total.add(1 + retries, { operation_type: 'read' })
}

let writeCounter = 0

async function writeOp(): Promise<void> {
	let id = new Uint64(BigInt(writeCounter++))
	let start = performance.now()
	let retries = 0
	let status: 'success' | 'error' | 'aborted' = 'error'
	inFlight.write++

	try {
		await sql`INSERT INTO test (hash, id, payload_str, payload_double, payload_timestamp) VALUES (
			Digest::NumericHash(${id}),
			${id},
			${randomUUID()},
			${Math.random()},
			${new Timestamp(new Date())}
		);`
			.isolation('serializableReadWrite')
			.signal(ctrl.signal)
			.on('retry', () => retries++)
		status = 'success'
		latency.write.recordValue(performance.now() - start)
	} catch (err) {
		if ((err as Error)?.name === 'AbortError' && ctrl.signal.aborted) {
			status = 'aborted'
		} else {
			console.error('write failed:', err)
		}
	} finally {
		inFlight.write--
	}

	if (status === 'aborted') return
	sdk_operations_total.add(1, { operation_type: 'write', operation_status: status })
	sdk_retry_attempts_total.add(1 + retries, { operation_type: 'write' })
}

// ---- Phase: setup ---------------------------------------------------------
async function setup(): Promise<void> {
	let [[[version]]] = (await sql`SELECT CAST(version() as Text);`.values()) as [[[string]]]
	console.log('YDB Server version:', version)

	await sql`
		DROP TABLE IF EXISTS test;
		CREATE TABLE IF NOT EXISTS test (
			hash				Uint64,
			id					Uint64,
			payload_str			Text,
			payload_double		Double,
			payload_timestamp	Timestamp,
			payload_hash		Uint64,

			PRIMARY KEY			(hash, id)
		)
		WITH (
			STORE = ROW,
			AUTO_PARTITIONING_BY_SIZE = ENABLED,
			AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 6,
			AUTO_PARTITIONING_MAX_PARTITIONS_COUNT = 1000
		);`

	console.log('prefilling %d rows (concurrency=%d)', PREFILL_COUNT, PREFILL_CONCURRENCY)
	await Promise.all(
		Array.from({ length: PREFILL_CONCURRENCY }, async () => {
			// eslint-disable-next-line no-await-in-loop -- parallelism via PREFILL_CONCURRENCY fan-out; each worker runs sequentially
			while (writeCounter < PREFILL_COUNT) await writeOp()
		})
	)
	console.log('prefill done')
}

// ---- Phase: run -----------------------------------------------------------
async function pace(rps: number, op: () => Promise<void>): Promise<void> {
	let limiter = new RateLimiter(rps)
	let inflight = new Set<Promise<void>>()
	while (!ctrl.signal.aborted) {
		try {
			// eslint-disable-next-line no-await-in-loop -- rate limiter must pace sequentially
			await limiter.wait(ctrl.signal)
		} catch {
			break
		}
		let p = op().finally(() => inflight.delete(p))
		inflight.add(p)
	}
	await Promise.allSettled(inflight)
}

async function run(): Promise<void> {
	console.log('running for %ds: read %d RPS, write %d RPS', DURATION, READ_RPS, WRITE_RPS)

	sleep(DURATION * 1000).then(() => {
		console.error('duration elapsed, stopping workers...')
		ctrl.abort()
	})

	await Promise.all([pace(READ_RPS, readOp), pace(WRITE_RPS, writeOp)])
}

// ---- Phase: cleanup -------------------------------------------------------
async function cleanup(): Promise<void> {
	try {
		await meterProvider.forceFlush()
	} catch (err) {
		console.error('meter flush failed:', err)
	}
	try {
		await meterProvider.shutdown()
	} catch (err) {
		console.error('meter shutdown failed:', err)
	}
	try {
		driver.close()
	} catch (err) {
		console.error('driver close failed:', err)
	}
}

// ---- Entry ----------------------------------------------------------------
let exitCode = 0
try {
	await setup()
	await run()
} catch (err) {
	console.error('workload failed:', err)
	exitCode = 1
} finally {
	await cleanup()
}
process.exit(exitCode)
