import { randomUUID } from 'node:crypto'
import { workerData } from 'node:worker_threads'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { query } from '@ydbjs/query'
import { Timestamp, Uint64 } from '@ydbjs/value/primitive'

import { installSafetyHandlers } from '../../lib/safety.ts'
import type { WorkerData } from '../../lib/worker-api.ts'

installSafetyHandlers()

let { params } = workerData as WorkerData
let prefill = parseInt(params['prefill'] ?? '1000', 10)
let concurrency = parseInt(params['concurrency'] ?? '50', 10)

let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()
let sql = query(driver)

let [[[version]]] = (await sql`SELECT CAST(version() as Text);`.values()) as [[[string]]]
console.log('[kv.setup] YDB server version:', version)

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

console.log('[kv.setup] prefilling %d rows (concurrency=%d)', prefill, concurrency)

let next = 0
async function prefillOp(): Promise<void> {
	let id = new Uint64(BigInt(next++))
	try {
		await sql`INSERT INTO test (hash, id, payload_str, payload_double, payload_timestamp) VALUES (
			Digest::NumericHash(${id}),
			${id},
			${randomUUID()},
			${Math.random()},
			${new Timestamp(new Date())}
		);`
			.idempotent(false)
			.isolation('serializableReadWrite')
	} catch (err) {
		if (err instanceof YDBError && err.code === StatusIds_StatusCode.PRECONDITION_FAILED) return
		throw err
	}
}

await Promise.all(
	Array.from({ length: concurrency }, async () => {
		// oxlint-disable-next-line no-await-in-loop
		while (next < prefill) await prefillOp()
	})
)

console.log('[kv.setup] prefill done')

driver.close()
process.exit(0)
