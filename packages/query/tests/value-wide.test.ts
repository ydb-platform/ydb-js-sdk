// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { expect, inject, test } from 'vitest'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import type { Value } from '@ydbjs/value'
import { Date32, Datetime64, Interval64, Timestamp64 } from '@ydbjs/value/primitive'

type WireRow = { value: WireValue }
type ValueRow = { value: Value }

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('wide scalar constructors retain exact parameter units without losing their default Value representation', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let cases = [
		new Date32(-1),
		new Datetime64(-1n),
		new Timestamp64(-1000001n),
		new Interval64(-9007199254740993n),
	]

	for (let value of cases) {
		let raw = await sql<[WireRow]>`SELECT ${value} AS value`.raw().signal(tc.signal)
		let rows = await sql<[ValueRow]>`SELECT ${value} AS value`.signal(tc.signal)

		expect(raw[0]![0]!.value).toEqual(value.encode())
		expect(rows[0]![0]!.value.encode()).toEqual(value.encode())
		expect(rows[0]![0]!.value.type.encode()).toEqual(value.type.encode())
	}
})
