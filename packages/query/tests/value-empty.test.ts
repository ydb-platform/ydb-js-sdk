import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { EmptyDict, EmptyList } from '@ydbjs/value/empty'

type EmptyRow = { list: unknown[]; dict: Map<unknown, unknown> }

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('named empty constructors work as query parameters', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)

	let result = await sql<
		[EmptyRow]
	>`SELECT ${new EmptyList()} AS list, ${new EmptyDict()} AS dict`.signal(tc.signal)

	expect(result[0]![0]).toEqual({ list: [], dict: new Map() })
})

test('untyped empty server containers decode to native empty containers', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	expect(await sql`SELECT [] AS list, AsDict() AS dict`.signal(tc.signal)).toEqual([
		[{ list: [], dict: new Map() }],
	])
})
