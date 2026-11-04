// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { Pg, PgType } from '@ydbjs/value/pg'

type PgRow = { value: Pg }

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('Pg query results preserve their descriptor and text payload', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)

	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<[PgRow]>('SELECT PgConst("42", PgType("int4")) AS value;')
	)
	let value = result.resultSets[0]!.rows[0]!.value

	expect(value).toBeInstanceOf(Pg)
	expect(value.value).toBe('42')
	expect(value.type).toMatchObject({ typeName: 'pgint4', oid: 23, typlen: 4, typmod: -1 })
})

test('Pg text, binary, null and OID-only parameters reach the server without JS coercion', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	await using sql = query(client)
	let type = new PgType({ typeName: 'pgint4', oid: 23, typlen: 4, typmod: -1 })
	let cases = [
		[new Pg('42', type), '42'],
		[new Pg(new Uint8Array([0, 0, 0, 42]), type), '42'],
		[new Pg(null, type), null],
	] as const
	for (let [value, expected] of cases) {
		let rows = await sql<[PgRow]>`SELECT ${value} AS value`.signal(tc.signal)
		let result = rows[0]![0]!.value

		expect(result).toBeInstanceOf(Pg)
		expect(result.value).toBe(expected)
		expect(result.type.encode()).toEqual(type.encode())
	}

	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<[PgRow]>('DECLARE $value AS pgint4; SELECT $value AS value;', {
			value: new Pg('42', new PgType({ oid: 23 })),
		})
	)

	expect(result.resultSets[0]!.rows[0]!.value.value).toBe('42')
	expect(result.resultSets[0]!.rows[0]!.value.type.oid).toBe(23)
})
