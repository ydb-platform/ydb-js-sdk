// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { expect, inject, test } from 'vitest'
import { TZDate } from '@date-fns/tz'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { type Value, fromYdb } from '@ydbjs/value'
import { Decimal, DecimalType } from '@ydbjs/value/decimal'
import { EmptyDict, EmptyList } from '@ydbjs/value/empty'
import {
	Date32,
	Datetime64,
	DyNumber,
	Interval64,
	Timestamp64,
	TzDate32,
	TzDatetime64,
	TzTimestamp64,
} from '@ydbjs/value/primitive'
function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('Decimal text and special values preserve their exact wire values through query parameters', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	await using sql = query(client)
	let type = new DecimalType(22, 9)
	for (let text of ['123.456000001', '-0.000000001', 'inf', '-inf', 'nan']) {
		let value = new Decimal(text, type)
		let raw = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute<{ value: WireValue }>(
				'DECLARE $value AS Decimal(22,9); SELECT $value AS value;',
				{ value },
				{ raw: true }
			)
		)
		expect(raw.resultSets[0]!.columns[0]!.type).toEqual(type.encode())
		expect(raw.resultSets[0]!.rows[0]!.value).toEqual(value.encode())
		let rows = await sql<{ value: string }[]>`SELECT ${value} AS value`.signal(tc.signal)
		expect(rows[0]![0]!.value).toBe(text)
	}
})

test('named empty constructors work as query parameters', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let result = await sql<
		{ list: unknown[]; dict: Map<unknown, unknown> }[]
	>`SELECT ${new EmptyList()} AS list, ${new EmptyDict()} AS dict`.signal(tc.signal)
	expect(result[0]![0]).toEqual({ list: [], dict: new Map() })
})

test('wide scalar constructors retain exact parameter units before native projection', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let cases: [Value, unknown][] = [
		[new Date32(-1), new Date('1969-12-31T00:00:00Z')],
		[new Datetime64(-1n), new Date('1969-12-31T23:59:59Z')],
		[new Timestamp64(-1000001n), new Date('1969-12-31T23:59:59Z')],
		[new Interval64(-9007199254740993n), -9007199254740993n],
	]
	for (let [value, expected] of cases) {
		let raw = await sql<{ value: WireValue }[]>`SELECT ${value} AS value`
			.raw()
			.signal(tc.signal)
		expect(raw[0]![0]!.value).toEqual(value.encode())
		let rows = await sql<{ value: unknown }[]>`SELECT ${value} AS value`.signal(tc.signal)
		expect(rows[0]![0]!.value).toEqual(expected)
	}
	let number = new DyNumber('123456789012345678901234567890.12345678')
	let raw = await sql<{ value: WireValue }[]>`SELECT ${number} AS value`.raw().signal(tc.signal)
	let rows = await sql<{ value: string }[]>`SELECT ${number} AS value`.signal(tc.signal)
	expect(raw[0]![0]!.value.value.case).toBe('textValue')
	expect(rows[0]![0]!.value).toBe(raw[0]![0]!.value.value.value)
	expect(typeof rows[0]![0]!.value).toBe('string')
})

test('extended timezone parameters retain BCE dates and sub-millisecond wire precision', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	await using sql = query(client)
	let cases = [
		[new TzDate32('-1-02-29,UTC'), 68, [0, 1, 29, 0, 0, 0, 0]],
		[new TzDatetime64('10000-01-01T12:34:56,UTC'), 69, [10000, 0, 1, 12, 34, 56, 0]],
		[new TzTimestamp64('-1-02-29T12:34:56.123456,UTC'), 70, [0, 1, 29, 12, 34, 56, 123]],
	] as const
	let wires: WireValue[] = []
	for (let [value, id, expected] of cases) {
		let raw = await sql<{ value: WireValue }[]>`SELECT ${value} AS value`
			.raw()
			.signal(tc.signal)
		let wire = raw[0]![0]!.value
		wires.push(wire)
		expect(wire.value.case).toBe('textValue')
		expect(fromYdb(wire, value.type.encode()).encode()).toEqual(wire)
		let result = await sql<{ value: TZDate }[]>`SELECT ${value} AS value`.signal(tc.signal)
		let projected = result[0]![0]!.value
		expect(projected).toBeInstanceOf(TZDate)
		expect(projected.timeZone).toBe('UTC')
		expect([
			projected.getFullYear(),
			projected.getMonth(),
			projected.getDate(),
			projected.getHours(),
			projected.getMinutes(),
			projected.getSeconds(),
			projected.getMilliseconds(),
		]).toEqual(expected)
		let server = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute<{ value: WireValue }>(
				`DECLARE $value AS ${id === 68 ? 'TzDate32' : id === 69 ? 'TzDatetime64' : 'TzTimestamp64'}; SELECT $value AS value;`,
				{ value },
				{ raw: true }
			)
		)
		expect(server.resultSets[0]!.columns[0]!.type?.type).toEqual({ case: 'typeId', value: id })
	}
	expect(wires[2]!.value.value).toContain('.123456,UTC')
})
