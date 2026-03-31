import { randomInt, randomUUID } from 'node:crypto'
import { setInterval, setTimeout } from 'node:timers/promises'

import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Timestamp, Uint64 } from '@ydbjs/value/primitive'
import * as hdr from 'hdr-histogram-js'

import { meterProvider } from './lib/telemetry.ts'

const QPS = 100
const MAX_CONCURRENCY_READ = 200
const MAX_CONCURRENCY_WRITE = 50

let ctrl = new AbortController()
let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)

let sql = query(driver)
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

let meter = meterProvider.getMeter('slo-meter')

let latency_read = hdr.build({
	highestTrackableValue: 60 * 1000,
	numberOfSignificantValueDigits: 5,
})

let latency_write = hdr.build({
	highestTrackableValue: 60 * 1000,
	numberOfSignificantValueDigits: 5,
})

type OperationAttributes = {
	operation_type: 'read' | 'write'
	operation_status: 'success' | 'error'
}

type RetryAttributes = {
	operation_type: 'read' | 'write'
}

let sdk_operations_total = meter.createCounter<OperationAttributes>('sdk_operations_total', {
	valueType: 0,
})

let sdk_retry_attempts_total = meter.createCounter<RetryAttributes>('sdk_retry_attempts_total', {
	valueType: 0,
})

let inFlightRead = 0
let inFlightWrite = 0

meter
	.createObservableGauge('sdk_memory_usage', {
		unit: 'bytes',
		valueType: 0,
		description: 'Memory usage',
	})
	.addCallback((observableResult) => {
		let usage = process.memoryUsage()

		observableResult.observe(usage.rss, { type: 'rss' })
		observableResult.observe(usage.external, { type: 'external' })
		observableResult.observe(usage.heapUsed, { type: 'heapUsed' })
		observableResult.observe(usage.heapTotal, { type: 'heapTotal' })
		observableResult.observe(usage.arrayBuffers, { type: 'arrayBuffers' })
	})

meter
	.createObservableGauge('sdk_pending_operations', {
		unit: 'operations',
		valueType: 0,
		description: 'Pending operations',
	})
	.addCallback((observableResult) => {
		observableResult.observe(inFlightRead, { operation_type: 'read' })
		observableResult.observe(inFlightWrite, { operation_type: 'write' })
	})

meter
	.createObservableGauge<OperationAttributes>('sdk_operation_latency_p50_seconds', {
		unit: 'seconds',
		valueType: 1,
	})
	.addCallback((observableResult) => {
		observableResult.observe(latency_read.getValueAtPercentile(50) / 1000, {
			operation_type: 'read',
			operation_status: 'success',
		})

		observableResult.observe(latency_write.getValueAtPercentile(50) / 1000, {
			operation_type: 'write',
			operation_status: 'success',
		})
	})

meter
	.createObservableGauge<OperationAttributes>('sdk_operation_latency_p95_seconds', {
		unit: 'seconds',
		valueType: 1,
	})
	.addCallback((observableResult) => {
		observableResult.observe(latency_read.getValueAtPercentile(95) / 1000, {
			operation_type: 'read',
			operation_status: 'success',
		})

		observableResult.observe(latency_write.getValueAtPercentile(95) / 1000, {
			operation_type: 'write',
			operation_status: 'success',
		})
	})

meter
	.createObservableGauge<OperationAttributes>('sdk_operation_latency_p99_seconds', {
		unit: 'seconds',
		valueType: 1,
	})
	.addCallback((observableResult) => {
		observableResult.observe(latency_read.getValueAtPercentile(99) / 1000, {
			operation_type: 'read',
			operation_status: 'success',
		})

		observableResult.observe(latency_write.getValueAtPercentile(99) / 1000, {
			operation_type: 'write',
			operation_status: 'success',
		})

		latency_read.reset()
		latency_write.reset()
	})

async function read(maxId: number) {
	if (ctrl.signal.aborted) return

	let start = performance.now()
	let randomId = new Uint64(BigInt(randomInt(maxId)))

	let status = 0
	let retries = 0
	try {
		await sql`SELECT * from test WHERE id = ${randomId} AND hash = Digest::NumericHash(${randomId})`
			.idempotent(true)
			.isolation('onlineReadOnly')
			.signal(ctrl.signal)
			.on('retry', () => retries++)

		status = 1
		latency_read.recordValue(performance.now() - start)
	} finally {
		sdk_operations_total.add(1, {
			operation_type: 'read',
			operation_status: status ? 'success' : 'error',
		})

		sdk_retry_attempts_total.add(retries, {
			operation_type: 'read',
		})
	}
}

async function write(curId: number) {
	if (ctrl.signal.aborted) return

	let start = performance.now()
	let id = new Uint64(BigInt(curId))

	let status = 0
	let retries = 0
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

		status = 1
		latency_write.recordValue(performance.now() - start)
	} finally {
		sdk_operations_total.add(1, {
			operation_type: 'write',
			operation_status: status ? 'success' : 'error',
		})

		sdk_retry_attempts_total.add(retries, {
			operation_type: 'write',
		})
	}
}

let curId: number = 0

async function spawn_read() {
	if (ctrl.signal.aborted) return

	while (inFlightRead < MAX_CONCURRENCY_READ) {
		ctrl.signal.throwIfAborted()

		inFlightRead += 1
		void read(curId)
			.catch(() => {})
			.finally(() => (inFlightRead = Math.max(0, inFlightRead - 1)))
	}
}

async function spawn_write() {
	if (ctrl.signal.aborted) return

	while (inFlightWrite < MAX_CONCURRENCY_WRITE) {
		ctrl.signal.throwIfAborted()

		inFlightWrite += 1
		void write(curId++)
			.catch(() => {})
			.finally(() => (inFlightWrite = Math.max(0, inFlightWrite - 1)))
	}
}

process.on('SIGINT', async () => {
	console.error(' SIGINT received, closing workers...')

	ctrl.abort()
})

setTimeout(parseInt(process.env['WORKLOAD_DURATION'] || '60') * 1000).then(() => {
	console.error('Timeout, closing workers...')

	return ctrl.abort()
})

try {
	for await (let _ of setInterval(1000 / QPS, void 0, { signal: ctrl.signal })) {
		await spawn_write()
		await spawn_read()
	}
} catch (err) {
	if (err instanceof Error && err.name === 'AbortError') {
		process.exit(0)
	} else {
		console.error(err)
	}
} finally {
	latency_read.reset()
	latency_write.reset()
	await meterProvider.shutdown()
}

process.exit(0)
