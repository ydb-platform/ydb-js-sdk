// eslint-disable no-await-in-loop
import { randomInt, randomUUID } from "node:crypto"

import { Driver } from "@ydbjs/core"
import { query } from "@ydbjs/query"
import { Timestamp, Uint64 } from "@ydbjs/value/primitive"

import { meterProvider } from "./telemetry.ts"

const RPS = 200
const MAX_CONCURRENCY_READ = 1000
const MAX_CONCURRENCY_WRITE = 500

let ctrl = new AbortController()
let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)

let sql = query(driver)
let [[[version]]] = await sql`SELECT CAST(version() as Text);`.values()

console.log("YDB Server version:", version)

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

let meter = meterProvider.getMeter('slo-meter');
let sdk_errors_total = meter.createCounter("sdk_errors_total", { valueType: 0 })
let sdk_operations_total = meter.createCounter("sdk_operations_total", { valueType: 0 })
let sdk_retry_attempts_total = meter.createCounter("sdk_retry_attempts_total", { valueType: 0 })
let sdk_operations_success_total = meter.createCounter("sdk_operations_success_total", { valueType: 0 })
let sdk_operations_failure_total = meter.createCounter("sdk_operations_failure_total", { valueType: 0 })
let sdk_operation_latency_seconds = meter.createHistogram("sdk_operation_latency_seconds", { unit: 'seconds', valueType: 1 })

let curId = 1
let inFlightRead = 0;
let inFlightWrite = 0;

meter.createObservableGauge("sdk_pending_operations", { unit: 'operations', valueType: 0, description: "Pending operations" })
	.addCallback((observableResult) => {
		observableResult.observe(inFlightRead + inFlightWrite, { operation_type: "all" })
		observableResult.observe(inFlightRead, { operation_type: "read" })
		observableResult.observe(inFlightWrite, { operation_type: "write" })
	})

meter.createObservableGauge("sdk_memory_usage", { unit: 'bytes', valueType: 0, description: "Memory usage" })
	.addCallback((observableResult) => {
		let usage = process.memoryUsage();

		observableResult.observe(usage.rss, { type: "rss" })
		observableResult.observe(usage.external, { type: "external" })
		observableResult.observe(usage.heapUsed, { type: "heapUsed" })
		observableResult.observe(usage.heapTotal, { type: "heapTotal" })
		observableResult.observe(usage.arrayBuffers, { type: "arrayBuffers" })
	})

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function read(maxId: number) {
	if (ctrl.signal.aborted) return

	let start = performance.now()
	let randomId = new Uint64(BigInt(randomInt(maxId)))

	try {
		await using _ = sql`SELECT * from test WHERE id = ${randomId} AND hash = Digest::NumericHash(${randomId})`
			.isolation('onlineReadOnly')
			.timeout(10 * 10000)
			.signal(ctrl.signal)
			.on('retry', ({ error }) => {
				sdk_errors_total.add(1, { operation_type: "read", error_type: error instanceof Error ? error.name : "Unknown" })
				sdk_retry_attempts_total.add(1, { operation_type: "read", error_type: error instanceof Error ? error.name : "Unknown" })
			})

		sdk_operations_success_total.add(1, { operation_type: "read" })
	} catch (err) {
		sdk_operations_failure_total.add(1, { operation_type: "read" })
		sdk_errors_total.add(1, { operation_type: "read", error_type: err instanceof Error ? err.name : "Unknown" })
	} finally {
		sdk_operations_total.add(1, { operation_type: "read" })
		sdk_operation_latency_seconds.record((performance.now() - start) / 1000, { operation_type: "read" })
	}
}

async function write(curId: number) {
	if (ctrl.signal.aborted) return

	let start = performance.now()
	let id = new Uint64(BigInt(curId))

	try {
		await using _ = sql`INSERT INTO test (hash, id, payload_str, payload_double, payload_timestamp) VALUES (
			Digest::NumericHash(${id}),
			${id},
			${randomUUID()},
			${Math.random()},
			${new Timestamp(new Date())}
		);`
			.isolation('serializableReadWrite')
			.timeout(10 * 10000)
			.signal(ctrl.signal)
			.on('retry', ({ error }) => {
				sdk_errors_total.add(1, { operation_type: "write", error_type: error instanceof Error ? error.name : "Unknown" })
				sdk_retry_attempts_total.add(1, { operation_type: "write", error_type: error instanceof Error ? error.name : "Unknown" })
			})

		sdk_operations_success_total.add(1, { operation_type: "write" })
	} catch (err) {
		sdk_operations_failure_total.add(1, { operation_type: "write" })
		sdk_errors_total.add(1, { operation_type: "write", error_type: err instanceof Error ? err.name : "Unknown" })
	} finally {
		sdk_operations_total.add(1, { operation_type: "write" })
		sdk_operation_latency_seconds.record((performance.now() - start) / 1000, { operation_type: "write" })
	}
}

function spawn_read() {
	if (ctrl.signal.aborted) return

	while (inFlightRead < MAX_CONCURRENCY_READ) {
		ctrl.signal.throwIfAborted()

		inFlightRead += 1
		read(curId).then(() => (inFlightRead -= 1))
	}
};

function spawn_write() {
	if (ctrl.signal.aborted) return

	while (inFlightWrite < MAX_CONCURRENCY_WRITE) {
		ctrl.signal.throwIfAborted()

		inFlightWrite += 1
		write(curId++).then(() => (inFlightWrite -= 1))
	}
};

setTimeout(() => {
	console.error("Timeout, closing workers...")

	ctrl.abort()
}, 30 * 60 * 1000)

process.on('SIGINT', async () => {
	console.error(" SIGINT received, closing workers...")

	ctrl.abort()
});

while (!ctrl.signal.aborted) {
	spawn_read();
	spawn_write();

	await sleep(1000 / RPS);
}

await meterProvider.shutdown()

process.exit(0)
