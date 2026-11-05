import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import type { Value } from '@ydbjs/api/value'
import { Uint64 } from '@ydbjs/value/primitive'

type JsonRow = {
	value: Record<string, unknown>
	named: Record<string, unknown>
}

type NamedRow = Record<string, number>
type NumericRow = Record<'id' | 'wide' | 'exact', Value>

test('named bindings infer numeric types and preserve an explicitly unsigned value', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let unsigned = 2n ** 63n

	let [[row]] = await sql<[NumericRow]>`SELECT $id AS id, $wide AS wide, $exact AS exact`
		.parameter('id', 42)
		.param('$wide', 42n)
		.parameter('exact', new Uint64(unsigned))
		.raw()
		.signal(tc.signal)

	expect(row!.id.value).toEqual({ case: 'int32Value', value: 42 })
	expect(row!.wide.value).toEqual({ case: 'int64Value', value: 42n })
	expect(row!.exact.value).toEqual({ case: 'uint64Value', value: unsigned })
})

test('JSON type-like fields cannot add statements to tagged SQL', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let input = JSON.parse(
		'{"type":{"kind":2,"precision":"1,0); $p0 = 0; SELECT 999 AS injected; --","scale":0}}'
	)

	let result = await sql<[JsonRow]>`SELECT ${input} AS value, $input AS named;`
		.parameter('input', input)
		.signal(tc.signal)

	expect(result).toHaveLength(1)
	expect(result[0]).toHaveLength(1)
	expect(result[0]![0]).toEqual({ value: input, named: input })
})

test('quoted identifiers cannot add statements through backslash escapes', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let name = 'field\\`; SELECT 999 AS injected; --'

	let result = await sql<[NamedRow]>`SELECT 1 AS ${sql.identifier(name)};`.signal(tc.signal)

	expect(result).toHaveLength(1)
	expect(Object.entries(result[0]![0]!)).toEqual([[name, 1]])
})
