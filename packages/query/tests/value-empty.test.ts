import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { EmptyDict, EmptyList } from '@ydbjs/value/empty'

type EmptyRow = { list: unknown[]; dict: Map<unknown, unknown> }

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('tagged SQL binds explicitly declared EmptyList and EmptyDict parameters', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)

	let result = await sql<[EmptyRow]>`
		DECLARE $list AS EmptyList;
		DECLARE $dict AS EmptyDict;
		SELECT $list AS list, $dict AS dict;
	`
		.parameter('list', new EmptyList())
		.parameter('dict', new EmptyDict())
		.signal(tc.signal)

	expect(result[0]![0]).toEqual({ list: [], dict: new Map() })
})

test('untyped empty server containers decode to native empty containers', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	expect(await sql`SELECT [] AS list, AsDict() AS dict`.signal(tc.signal)).toEqual([
		[{ list: [], dict: new Map() }],
	])
})
