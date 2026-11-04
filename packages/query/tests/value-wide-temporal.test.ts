// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { install } from 'temporal-polyfill/shim'
import { Temporal } from 'temporal-polyfill'
import { expect, inject, test } from 'vitest'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import type { Value } from '@ydbjs/value'
import { Date32, Datetime64, Interval64, Timestamp64 } from '@ydbjs/value/primitive'

type WireRow = { value: WireValue }
type TemporalScalar = Temporal.PlainDate | Temporal.Instant | Temporal.Duration
type TemporalRow = { value: TemporalScalar }

install()

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('wide scalar constructors retain exact parameter units in Temporal projection', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver, { temporal: true })
	let cases: [Value, TemporalScalar][] = [
		[new Date32(-1), Temporal.PlainDate.from('1969-12-31')],
		[new Datetime64(-1n), Temporal.Instant.from('1969-12-31T23:59:59Z')],
		[new Timestamp64(-1000001n), Temporal.Instant.from('1969-12-31T23:59:58.999999Z')],
		[new Interval64(-9007199254740993n), Temporal.Duration.from('-PT9007199254.740993S')],
	]

	for (let [value, expected] of cases) {
		let raw = await sql<[WireRow]>`SELECT ${value} AS value`.raw().signal(tc.signal)
		let rows = await sql<[TemporalRow]>`SELECT ${value} AS value`.signal(tc.signal)
		let projected = rows[0]![0]!.value

		expect(raw[0]![0]!.value).toEqual(value.encode())
		expect(projected).toBeInstanceOf(expected.constructor)
		expect(projected.toString()).toBe(expected.toString())
	}
})
