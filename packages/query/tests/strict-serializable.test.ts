import { randomUUID } from 'node:crypto'

import { expect, inject, test } from 'vitest'

import { Driver } from '@ydbjs/core'

import { type QueryClient, query } from '../src/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

async function withTable(
	run: (sql: QueryClient, tableName: string) => Promise<void>
): Promise<void> {
	await using sql = query(driver)
	let tableName = `strict_rw_${randomUUID().replaceAll('-', '')}`
	let table = sql.identifier(tableName)

	await sql`CREATE TABLE ${table} (id Uint64, value Utf8, PRIMARY KEY (id))`
	try {
		await run(sql, tableName)
	} finally {
		await sql`DROP TABLE ${table}`
	}
}

// The shared CI server has StrictSerializableRW disabled; run these tests against a server with
// TableServiceConfig.EnableStrictSerializableIsolation enabled.
test.skipIf(process.env['YDB_STRICT_RW_INTEGRATION'] !== '1')(
	'returns the real commit timestamp and callback result from beginWithTimestamp',
	async () => {
		await withTable(async (sql, tableName) => {
			let table = sql.identifier(tableName)
			let commit = await sql.beginWithTimestamp(
				{ isolation: 'strictSerializableReadWrite' },
				async (tx) => {
					await tx`UPSERT INTO ${table} (id, value) VALUES (1, 'explicit')`
					return 42
				}
			)

			expect(commit.result).toBe(42)
			expect(commit.commitTimestamp).toMatchObject({
				planStep: expect.any(BigInt),
				txId: expect.any(BigInt),
			})
		})
	}
)

test.skipIf(process.env['YDB_STRICT_RW_INTEGRATION'] !== '1')(
	'returns the real timestamp from the trailing single-query response',
	async () => {
		await withTable(async (sql, tableName) => {
			let table = sql.identifier(tableName)
			let write = sql`UPSERT INTO ${table} (id, value) VALUES (2, 'single')`.isolation(
				'strictSerializableReadWrite'
			)
			await write

			expect(write.commitTimestamp()).toMatchObject({
				planStep: expect.any(BigInt),
				txId: expect.any(BigInt),
			})
		})
	}
)
