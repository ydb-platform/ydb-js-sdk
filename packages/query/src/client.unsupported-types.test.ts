import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { ExecuteQueryResponsePartSchema } from '@ydbjs/api/query'
import { TypeSchema, ValueSchema, type Value as WireValue } from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { startClientServer } from './client.fixtures.ts'
import { QueryClient, query } from './index.ts'

type RawPgRow = { value: WireValue }

let pgType = create(TypeSchema, {
	type: {
		case: 'pgType',
		value: { typeName: 'pgint4', oid: 23, typlen: 4, typmod: -1 },
	},
})
let pgValue = create(ValueSchema, { value: { case: 'textValue', value: '42' } })

// Simulate legacy protocol responses without requiring a server that supports PG SQL.
async function startLegacyPgServer() {
	return startClientServer({
		async *executeQuery() {
			yield create(ExecuteQueryResponsePartSchema, {
				status: Status.SUCCESS,
				resultSet: {
					columns: [{ name: 'value', type: pgType }],
					rows: [{ items: [pgValue] }],
				},
			})
		},
	})
}

test('session execution rejects PostgreSQL result schemas', async (tc) => {
	using server = await startLegacyPgServer()
	await using client = new QueryClient(server.driver)

	await expect(
		client.retrySession({ signal: tc.signal }, (session) => {
			return session.execute('SELECT value')
		})
	).rejects.toThrow(/PostgreSQL.*raw/)
})

test('the tagged facade rejects PostgreSQL result schemas', async (tc) => {
	using server = await startLegacyPgServer()
	await using sql = query(server.driver)

	await expect(sql`SELECT value`.signal(tc.signal)).rejects.toThrow(/PostgreSQL.*raw/)
})

test('raw session execution preserves PostgreSQL wire descriptors and values', async (tc) => {
	using server = await startLegacyPgServer()
	await using client = new QueryClient(server.driver)

	let result = await client.retrySession({ signal: tc.signal }, (session) => {
		return session.execute<[RawPgRow]>('SELECT value', {}, { raw: true })
	})
	let set = result.resultSets[0]!

	expect(set.columns[0]!.type).toEqual(pgType)
	expect(set.rows).toEqual([{ value: pgValue }])
})

test('the raw tagged facade preserves PostgreSQL wire values', async (tc) => {
	using server = await startLegacyPgServer()
	await using sql = query(server.driver)

	let result = await sql<[RawPgRow]>`SELECT value`.raw().signal(tc.signal)

	expect(result[0]).toEqual([{ value: pgValue }])
})
