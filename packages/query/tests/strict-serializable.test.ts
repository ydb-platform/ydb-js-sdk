import { randomUUID } from 'node:crypto'

import { afterAll, expect, inject, test } from 'vitest'

import { Driver } from '@ydbjs/core'

import { type SQLClient, query } from '../src/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()
afterAll(() => driver.close())

async function withTable(run: (sql: SQLClient, tableName: string) => Promise<void>): Promise<void> {
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

test.skipIf(process.env['YDB_STRICT_RW_INTEGRATION'] !== '1')(
	'returns ordered commit timestamps for explicit and inline commits on YDB',
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
			let explicit = commit.commitTimestamp!
			expect(explicit?.planStep).toBeGreaterThan(0n)
			expect(explicit?.txId).toBeGreaterThan(0n)

			let write = sql`
				UPSERT INTO ${table} (id, value) VALUES (2, 'inline');
				SELECT 42 AS marker;
			`.isolation('strictSerializableReadWrite')
			expect(write.commitTimestamp()).toBeUndefined()
			expect(await write).toEqual([[{ marker: 42 }]])

			let inline = write.commitTimestamp()!
			expect(inline?.planStep).toBeGreaterThan(0n)
			expect(inline?.txId).toBeGreaterThan(0n)
			expect(explicit.compare(inline)).toBeLessThan(0)

			let read = sql`SELECT value FROM ${table} ORDER BY id`.isolation(
				'strictSerializableReadWrite'
			)
			expect(await read).toEqual([[{ value: 'explicit' }, { value: 'inline' }]])
			expect(read.commitTimestamp()).toBeUndefined()
		})
	}
)
