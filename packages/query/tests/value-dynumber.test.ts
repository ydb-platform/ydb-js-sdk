import { expect, inject, test } from 'vitest'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { DyNumber } from '@ydbjs/value/primitive'

type WireRow = { value: WireValue }
type StringRow = { value: string }

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('DyNumber parameters retain decimal text through query projection', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let number = new DyNumber('123456789012345678901234567890.12345678')

	let raw = await sql<[WireRow]>`SELECT ${number} AS value`.raw().signal(tc.signal)
	let rows = await sql<[StringRow]>`SELECT ${number} AS value`.signal(tc.signal)

	expect(raw[0]![0]!.value.value.case).toBe('textValue')
	expect(rows[0]![0]!.value).toBe(raw[0]![0]!.value.value.value)
	expect(typeof rows[0]![0]!.value).toBe('string')
})
