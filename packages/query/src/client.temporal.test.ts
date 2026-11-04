import { install } from 'temporal-polyfill/shim'
import { Temporal } from 'temporal-polyfill'
import { create } from '@bufbuild/protobuf'
import { ExecuteQueryResponsePartSchema } from '@ydbjs/api/query'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { Type_PrimitiveTypeId } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { Primitive, Timestamp, Timestamp64, TzTimestamp } from '@ydbjs/value/primitive'
import { Struct } from '@ydbjs/value/struct'
import { afterEach, expect, test, vi } from 'vitest'
import { QueryClient } from './client.js'
import { query } from './index.js'
import { startClientServer } from './client.fixtures.js'

install()

afterEach(() => {
	vi.unstubAllGlobals()
})

let rowValue = new Struct({
	legacy: new Timestamp(1_234_567n),
	wide: new Timestamp64(-1n),
	zoned: new TzTimestamp('2025-01-01T00:00:00.123456,UTC'),
})

async function startTemporalServer() {
	return startClientServer({
		async *executeQuery() {
			yield create(ExecuteQueryResponsePartSchema, {
				status: Status.SUCCESS,
				resultSet: {
					columns: [{ name: 'value', type: rowValue.type.encode() }],
					rows: [{ items: [rowValue.encode()] }],
				},
			})
		},
	})
}

function expectTemporalRow(row: unknown) {
	expect(row).toHaveProperty('value.legacy', expect.any(Temporal.Instant))
	expect(row).toHaveProperty('value.legacy.epochNanoseconds', 1_234_567_000n)

	expect(row).toHaveProperty('value.wide', expect.any(Temporal.Instant))
	expect(row).toHaveProperty('value.wide.epochNanoseconds', -1000n)

	expect(row).toHaveProperty('value.zoned', expect.any(Temporal.ZonedDateTime))
	expect(row).toHaveProperty('value.zoned.microsecond', 456)
	expect(row).toHaveProperty('value.zoned.timeZoneId', 'UTC')
}

test('session execution converts Temporal results', async (tc) => {
	using server = await startTemporalServer()
	await using client = new QueryClient(server.driver, { temporal: true })

	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT value')
	)

	expect(result.resultSets).toHaveLength(1)
	expectTemporalRow(result.resultSets[0]!.rows[0])
})

test('transaction execution converts Temporal results', async (tc) => {
	using server = await startTemporalServer()
	await using client = new QueryClient(server.driver, { temporal: true })

	let result = await client.retryTransaction({ signal: tc.signal }, (tx) =>
		tx.execute('SELECT value')
	)

	expect(result.resultSets).toHaveLength(1)
	expectTemporalRow(result.resultSets[0]!.rows[0])
})

test('the tagged facade converts Temporal results', async (tc) => {
	using server = await startTemporalServer()
	await using sql = query(server.driver, { temporal: true })

	let result = await sql`SELECT value`.signal(tc.signal)

	expect(result).toHaveLength(1)
	expectTemporalRow(result[0]![0])
})

test('raw results preserve wire values when Temporal mode is enabled', async (tc) => {
	using server = await startTemporalServer()
	await using sql = query(server.driver, { temporal: true })

	let result = await sql`SELECT value`.raw().signal(tc.signal)

	expect(result[0]![0]).toEqual({ value: rowValue.encode() })
})

test('the client keeps its Temporal mode after the input options change', async (tc) => {
	using server = await startTemporalServer()
	let options = { temporal: true }
	await using client = new QueryClient(server.driver, options)

	options.temporal = false

	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT value')
	)

	expect(result.resultSets).toHaveLength(1)
	expectTemporalRow(result.resultSets[0]!.rows[0])
})

test('default clients preserve Date results and typed wide or zoned values without Temporal', async (tc) => {
	using server = await startTemporalServer()
	vi.stubGlobal('Temporal', undefined)
	await using client = new QueryClient(server.driver)

	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT value')
	)
	let row = result.resultSets[0]!.rows[0]

	expect(row).toHaveProperty('value.legacy', new Date(1234))

	expect(row).toHaveProperty('value.wide', expect.any(Primitive))
	expect(row).toHaveProperty('value.wide.type.id', Type_PrimitiveTypeId.TIMESTAMP64)
	expect(row).toHaveProperty('value.wide.value', -1n)

	expect(row).toHaveProperty('value.zoned', expect.any(Primitive))
	expect(row).toHaveProperty('value.zoned.type.id', Type_PrimitiveTypeId.TZ_TIMESTAMP)
	expect(row).toHaveProperty('value.zoned.value', '2025-01-01T00:00:00.123456,UTC')
})

test('Temporal mode requires a global Temporal implementation at client construction', () => {
	using driver = new Driver('grpc://127.0.0.1:2136/local', {
		'ydb.sdk.enable_discovery': false,
	})
	vi.stubGlobal('Temporal', undefined)

	expect(() => new QueryClient(driver, { temporal: true })).toThrow(/Temporal is not available/)
})

test('QueryClient rejects non-boolean Temporal options', () => {
	using driver = new Driver('grpc://127.0.0.1:2136/local', {
		'ydb.sdk.enable_discovery': false,
	})

	for (let temporal of ['true', null, 1])
		expect(() => new QueryClient(driver, { temporal } as never)).toThrow(/boolean/)
})

test('QueryClient rejects non-object options', () => {
	using driver = new Driver('grpc://127.0.0.1:2136/local', {
		'ydb.sdk.enable_discovery': false,
	})

	for (let options of [null, true, []])
		expect(() => new QueryClient(driver, options as never)).toThrow(/options must be an object/)
})

test('the tagged facade rejects Temporal options for an existing client', () => {
	using driver = new Driver('grpc://127.0.0.1:2136/local', {
		'ydb.sdk.enable_discovery': false,
	})
	using client = new QueryClient(driver, { temporal: true })

	// @ts-expect-error Existing clients own their conversion options.
	expect(() => query(client, { temporal: true })).toThrow(/Configure options on QueryClient/)
})

test('session scopes reject misplaced Temporal options before executing a query', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver, { temporal: true })

	await expect(
		client.retrySession({ signal: tc.signal, temporal: true } as never, (session) =>
			session.execute('SELECT value')
		)
	).rejects.toThrow(/temporal belongs to QueryClient options/)

	expect(server.executions).toHaveLength(0)
})

test('transaction scopes reject misplaced Temporal options before beginning a transaction', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver, { temporal: true })

	await expect(
		client.retryTransaction({ signal: tc.signal, temporal: false } as never, (tx) =>
			tx.execute('SELECT value')
		)
	).rejects.toThrow(/temporal belongs to QueryClient options/)

	expect(server.begins).toHaveLength(0)
	expect(server.executions).toHaveLength(0)
})

test('statement options reject misplaced Temporal options before executing a query', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver, { temporal: true })

	await expect(
		client.retrySession({ signal: tc.signal }, (session) =>
			session.execute('SELECT value', {}, { temporal: false } as never)
		)
	).rejects.toThrow(/temporal belongs to QueryClient options/)

	expect(server.executions).toHaveLength(0)
})
