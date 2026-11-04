// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { install } from 'temporal-polyfill/shim'
import { expect, inject, test } from 'vitest'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { type Value, fromYdb } from '@ydbjs/value'
import { TzDate32, TzDatetime64, TzTimestamp64 } from '@ydbjs/value/primitive'

type WireRow = { value: WireValue }
type ValueRow = { value: Value }

install()

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('extended timezone parameters retain exact default Value representations', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	await using sql = query(client)
	let cases = [
		[new TzDate32('-1-02-29,UTC'), 68],
		[new TzDatetime64('10000-01-01T12:34:56,UTC'), 69],
		[new TzTimestamp64('-1-02-29T12:34:56.123456,UTC'), 70],
	] as const
	let wires: WireValue[] = []

	for (let [value, id] of cases) {
		let raw = await sql<[WireRow]>`SELECT ${value} AS value`.raw().signal(tc.signal)
		let wire = raw[0]![0]!.value
		let result = await sql<[ValueRow]>`SELECT ${value} AS value`.signal(tc.signal)
		let server = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute<[WireRow]>(
				`DECLARE $value AS ${id === 68 ? 'TzDate32' : id === 69 ? 'TzDatetime64' : 'TzTimestamp64'}; SELECT $value AS value;`,
				{ value },
				{ raw: true }
			)
		)
		let projected = result[0]![0]!.value

		wires.push(wire)
		expect(wire.value.case).toBe('textValue')
		expect(fromYdb(wire, value.type.encode()).encode()).toEqual(wire)
		expect(projected.encode()).toEqual(wire)
		expect(projected.type.encode()).toEqual(value.type.encode())
		expect(server.resultSets[0]!.columns[0]!.type?.type).toEqual({ case: 'typeId', value: id })
	}

	expect(wires[2]!.value.value).toContain('.123456,UTC')
})
