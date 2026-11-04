// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { expect, inject, test } from 'vitest'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { Decimal, DecimalType } from '@ydbjs/value/decimal'

type WireRow = { value: WireValue }
type StringRow = { value: string }

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
			session.execute<[WireRow]>(
				'DECLARE $value AS Decimal(22,9); SELECT $value AS value;',
				{ value },
				{ raw: true }
			)
		)
		let rows = await sql<[StringRow]>`SELECT ${value} AS value`.signal(tc.signal)

		expect(raw.resultSets[0]!.columns[0]!.type).toEqual(type.encode())
		expect(raw.resultSets[0]!.rows[0]!.value).toEqual(value.encode())
		expect(rows[0]![0]!.value).toBe(text)
	}
})
