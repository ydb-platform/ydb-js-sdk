import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

type JsonRow = { value: Record<string, unknown> }
type NamedRow = Record<string, number>

test('JSON type-like fields cannot add statements to tagged SQL', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let input = JSON.parse(
		'{"type":{"kind":2,"precision":"1,0); $p0 = 0; SELECT 999 AS injected; --","scale":0}}'
	)

	let result = await sql<[JsonRow]>`SELECT ${input} AS value;`.signal(tc.signal)

	expect(result).toHaveLength(1)
	expect(result[0]).toHaveLength(1)
	expect(result[0]![0]!.value).toEqual(input)
})

test('quoted identifiers cannot add statements through backslash escapes', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let name = 'field\\`; SELECT 999 AS injected; --'

	let result = await sql<[NamedRow]>`SELECT 1 AS ${sql.identifier(name)};`.signal(tc.signal)

	expect(result).toHaveLength(1)
	expect(Object.entries(result[0]![0]!)).toEqual([[name, 1]])
})
