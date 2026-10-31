import { expect, inject, test } from 'vitest'
import { StatsMode } from '@ydbjs/api/query'
import { Type_PrimitiveTypeId, type Value } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import type { TopicClient } from '@ydbjs/topic'
import { Uint64 } from '@ydbjs/value/primitive'
import { Int32Type } from '@ydbjs/value/primitive'
import { Optional } from '@ydbjs/value/optional'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { TransactionCompletionError, YDBError } from '@ydbjs/error'

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

let typedQuery = 'DECLARE $id AS Uint64; DECLARE $name AS Utf8; SELECT $id AS id, $name AS name;'
let rangeQuery = `SELECT id FROM AS_TABLE(ListMap(ListFromRange(0ul, 100000ul), ($id) -> (<|id: $id|>))) ORDER BY id;`

test('a postcommit error cannot repeat a real update through an outer SDK retrier', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver, { poolOptions: { maxSize: 2 } })
	let table = `query_postcommit_${crypto.randomUUID().replaceAll('-', '')}`
	await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute(`CREATE TABLE \`${table}\` (id Uint64, n Int64, PRIMARY KEY (id));`)
	)
	try {
		await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute(`UPSERT INTO \`${table}\` (id, n) VALUES (1ul, 0l);`)
		)
		let cause = new YDBError(StatusIds_StatusCode.ABORTED, [])
		let failure = await client
			.retrySession({ signal: tc.signal, retry: { budget: 2, strategy: 0 } }, async () => {
				return client.retryTransaction({ signal: tc.signal }, async (tx) => {
					await tx.execute(`UPDATE \`${table}\` SET n = n + 1l WHERE id = 1ul;`)
					tx.onClose(() => {
						throw cause
					})
				})
			})
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(TransactionCompletionError)
		expect(failure).toMatchObject({ committed: true, cause })
		let result = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute(`SELECT n FROM \`${table}\`;`)
		)
		expect(result.resultSets[0]!.rows).toEqual([{ n: 1n }])
	} finally {
		await client.retrySession({ signal: AbortSignal.timeout(5000) }, (session) =>
			session.execute(`DROP TABLE IF EXISTS \`${table}\`;`)
		)
	}
})

test('nested struct fields cannot change the decoded object prototype', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT AsStruct(1 AS `__proto__`, 2 AS `constructor`) AS nested;')
	)
	let nested = result.resultSets[0]!.rows[0]!.nested
	expect(nested).toStrictEqual(JSON.parse('{"__proto__":1,"constructor":2}'))
	expect(Object.getPrototypeOf(nested)).toBe(Object.prototype)
})

test('nested optional nulls decode correctly and retain their wire presence', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let text =
		'SELECT CAST(NULL AS Int32) AS outer_null, Just(CAST(NULL AS Int32)) AS inner_null, Just(Just(42)) AS some_value;'
	let result = await client.retrySession(
		{
			signal: tc.signal,
		},
		(session) => session.execute(text)
	)
	expect(result.resultSets[0]!.rows).toEqual([
		{ outer_null: null, inner_null: null, some_value: 42 },
	])
	let raw = await client.retrySession(
		{
			signal: tc.signal,
		},
		(session) => session.execute(text, {}, { raw: true })
	)
	expect(raw.resultSets[0]!.rows[0]!.inner_null).toMatchObject({
		value: { case: 'nestedValue', value: { value: { case: 'nullFlagValue' } } },
	})
	let parameter = new Optional(new Optional(null, new Int32Type()))
	let echoed = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute(
			'DECLARE $value AS Optional<Optional<Int32>>; SELECT $value AS value;',
			{ value: parameter },
			{ raw: true }
		)
	)
	expect(echoed.resultSets[0]!.rows[0]!.value).toMatchObject({
		value: { case: 'nestedValue', value: { value: { case: 'nullFlagValue' } } },
	})
})

test('ordinary query text binds explicitly declared native and typed parameters', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<{ id: bigint; name: string }>(typedQuery, {
			id: new Uint64(42n),
			name: 'plain query',
		})
	)
	expect(result.resultSets).toHaveLength(1)
	expect(result.resultSets[0]!.rows).toEqual([{ id: 42n, name: 'plain query' }])
	expect(result.resultSets[0]!.columns.map((column) => column.name)).toEqual(['id', 'name'])
	expect(result.resultSets[0]!.columns[0]!.type?.type).toEqual({
		case: 'typeId',
		value: Type_PrimitiveTypeId.UINT64,
	})
	expect(result.resultSets[0]!.truncated).toBe(false)
})

test('multiple result sets retain empty rows and their column metadata', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute(
			'SELECT id AS empty_id FROM AS_TABLE(AsList(AsStruct(1 AS id))) WHERE FALSE; SELECT 2 AS id; SELECT 3 AS id;'
		)
	)
	expect(result.resultSets.map((set) => set.rows)).toEqual([[], [{ id: 2 }], [{ id: 3 }]])
	expect(result.resultSets[0]!.columns.map((column) => column.name)).toEqual(['empty_id'])
	expect(result.resultSets.map((set) => set.truncated)).toEqual([false, false, false])
})

test('array and raw result modes preserve column order and YDB types', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let parameters = { id: new Uint64(42n), name: 'typed' }
	let arrays = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<unknown[]>(typedQuery, parameters, { rowMode: 'array' })
	)
	expect(arrays.resultSets[0]!.rows).toEqual([[42n, 'typed']])
	let raw = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<Value[]>(typedQuery, parameters, { rowMode: 'array', raw: true })
	)
	expect(raw.resultSets[0]!.columns.map((column) => column.name)).toEqual(['id', 'name'])
	expect(raw.resultSets[0]!.rows[0]!.map((value) => value.value)).toEqual([
		{ case: 'uint64Value', value: 42n },
		{ case: 'textValue', value: 'typed' },
	])
})

test('query statistics and trailers arrive with the completed result', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT 1 AS id', {}, { statsMode: StatsMode.BASIC })
	)
	expect(result.resultSets[0]!.rows).toEqual([{ id: 1 }])
	expect(result.stats).toBeDefined()
	expect(result.metadata).toMatchObject({ 'x-ydb-consumed-units': expect.any(String) })
})

test('retrySession keeps sequential buffered and streamed queries inside its session scope', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver, { poolOptions: { maxSize: 1 } })
	let result = await client.retrySession({ signal: tc.signal }, async (executor, signal) => {
		expect(executor.signal).toBe(signal)
		expect(executor.sessionId.length).toBeGreaterThan(0)
		let first = await executor.execute<{ id: number }>('SELECT 1 AS id')
		let total = first.resultSets[0]!.rows[0]!.id
		for await (let part of executor.stream<{ id: number }>('SELECT 2 AS id')) {
			for (let row of part.rows) total += row.id
		}
		return total
	})
	expect(result).toBe(3)
})

test('transaction precommit hooks can finish writes before the commit becomes visible', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let table = `query_hooks_${crypto.randomUUID().replaceAll('-', '')}`
	await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute(`CREATE TABLE \`${table}\` (id Uint64, value Utf8, PRIMARY KEY (id));`)
	)
	try {
		let events: string[] = []
		let write = `DECLARE $id AS Uint64; DECLARE $value AS Utf8; UPSERT INTO \`${table}\` (id, value) VALUES ($id, $value);`
		await client.retryTransaction({ signal: tc.signal }, async (tx) => {
			let topicTransaction: Parameters<TopicClient['createTxWriter']>[0] = tx
			expect(topicTransaction.transactionId.length).toBeGreaterThan(0)
			expect(topicTransaction.nodeId).toBe(tx.nodeId)
			topicTransaction.onCommit(async (signal) => {
				expect(signal).toBe(tx.signal)
				await tx.execute(write, { id: new Uint64(2n), value: 'hook' })
				events.push('precommit')
			})
			topicTransaction.onRollback(() => {
				events.push('rollback')
			})
			topicTransaction.onClose((committed) => {
				events.push(`closed:${committed}`)
			})
			await tx.execute(write, { id: new Uint64(1n), value: 'body' })
		})
		let result = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute(`SELECT id, value FROM \`${table}\` ORDER BY id`)
		)
		expect(result.resultSets[0]!.rows).toEqual([
			{ id: 1n, value: 'body' },
			{ id: 2n, value: 'hook' },
		])
		expect(events).toEqual(['precommit', 'closed:true'])
	} finally {
		await client.retrySession({ signal: AbortSignal.timeout(5000) }, (session) =>
			session.execute(`DROP TABLE IF EXISTS \`${table}\`;`)
		)
	}
})

test('transaction failure rolls back writes and reports uncommitted closure', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let table = `query_rollback_${crypto.randomUUID().replaceAll('-', '')}`
	await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute(`CREATE TABLE \`${table}\` (id Uint64, PRIMARY KEY (id));`)
	)
	try {
		let failure = new Error('abort transaction body')
		let events: unknown[] = []
		await expect(
			client.retryTransaction({ signal: tc.signal }, async (tx) => {
				tx.onRollback((error) => {
					events.push(error)
				})
				tx.onClose((committed) => {
					events.push(committed)
				})
				await tx.execute(`UPSERT INTO \`${table}\` (id) VALUES (1ul);`)
				throw failure
			})
		).rejects.toBe(failure)
		let result = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute(`SELECT id FROM \`${table}\``)
		)
		expect(result.resultSets[0]!.rows).toEqual([])
		expect(events).toEqual([failure, false])
	} finally {
		await client.retrySession({ signal: AbortSignal.timeout(5000) }, (session) =>
			session.execute(`DROP TABLE IF EXISTS \`${table}\`;`)
		)
	}
})

test('streaming reads all server parts without collecting rows', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let result = await client.retrySession({ signal: tc.signal }, async (scope) => {
		let stream = scope.stream<{ id: bigint }>(rangeQuery, {}, { responsePartLimitBytes: 1024 })
		let count = 0
		let parts = 0
		let sum = 0n
		for await (let part of stream) {
			parts++
			expect(part.resultSetIndex).toBe(0)
			for (let row of part.rows) {
				count++
				sum += row.id
			}
		}
		expect(stream.summary).toBeDefined()
		return { count, parts, sum }
	})
	expect(result.parts).toBeGreaterThan(1)
	expect(result.count).toBe(100000)
	expect(result.sum).toBe(4999950000n)
})

test('breaking an unfinished stream rejects its scope and allows a fresh query', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver, { poolOptions: { maxSize: 1 } })
	let read = 0
	let attempts = 0
	await expect(
		client.retrySession(
			{ signal: tc.signal, idempotent: true, retry: { budget: 2, strategy: 0 } },
			async (scope) => {
				attempts++
				let stream = scope.stream<{ id: bigint }>(
					rangeQuery,
					{},
					{ responsePartLimitBytes: 1024 }
				)
				for await (let part of stream) {
					read += part.rows.length
					break
				}
				expect(stream.summary).toBeUndefined()
			}
		)
	).rejects.toThrow(/closed before completion/i)
	expect(attempts).toBe(1)
	expect(read).toBeGreaterThan(0)
	expect(read).toBeLessThan(100000)
	let result = await client.retrySession(
		{
			signal: tc.signal,
		},
		(session) => session.execute('SELECT 7 AS id')
	)
	expect(result.resultSets[0]!.rows).toEqual([{ id: 7 }])
})

test('the tagged facade and plain client share a pool and transaction behavior', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver, { poolOptions: { maxSize: 1 } })
	let sql = query(client)
	let tagged = await sql`SELECT ${new Uint64(42n)} AS id`.signal(tc.signal)
	let plain = await client.retrySession(
		{
			signal: tc.signal,
		},
		(session) => session.execute('SELECT 43ul AS id')
	)
	let inTransaction = await sql.begin({ signal: tc.signal }, async (tx) => {
		return await tx`SELECT ${new Uint64(44n)} AS id`
	})
	expect(tagged).toEqual([[{ id: 42n }]])
	expect(plain.resultSets[0]!.rows).toEqual([{ id: 43n }])
	expect(inTransaction).toEqual([[{ id: 44n }]])
})
