import assert from 'node:assert/strict'

import { Driver } from '@ydbjs/core'
import { QueryClient, type QueryPart, query } from '@ydbjs/query'
import { Uint64 } from '@ydbjs/value/primitive'

type Row = { id: bigint }

async function sum(parts: AsyncIterable<QueryPart<Row>>): Promise<bigint> {
	let total = 0n
	for await (let part of parts) {
		for (let row of part.rows) total += row.id
	}
	return total
}

using driver = new Driver(process.env['YDB_CONNECTION_STRING'] ?? 'grpc://localhost:2136/local')
await using client = new QueryClient(driver)
let signal = AbortSignal.timeout(30_000)
let text = 'DECLARE $id AS Uint64; SELECT $id AS id;'
let parameters = { id: new Uint64(42n) }
let options = { signal, idempotent: true, retry: { budget: 3 } }

let result = await client.retrySession(options, (session) => session.execute<Row>(text, parameters))
let total = await client.retrySession(options, (session) =>
	sum(session.stream<Row>(text, parameters))
)
let transaction = await client.retryTransaction(options, (tx) => tx.execute<Row>(text, parameters))
assert.equal(result.resultSets[0]?.rows[0]?.id, 42n)
assert.equal(transaction.resultSets[0]?.rows[0]?.id, 42n)
assert.equal(total, 42n)
console.log('raw client: retrySession, streaming callback, retryTransaction = 42')

let sql = query(client)
let [[row]] = await sql<[Row]>`SELECT ${new Uint64(42n)} AS id`.signal(signal)
assert.equal(row?.id, 42n)
let taggedSession = await sql.do(options, async (attemptSignal) =>
	sql<[Row]>`SELECT ${new Uint64(42n)} AS id`.signal(attemptSignal)
)
let taggedTransaction = await sql.begin(
	options,
	async (tx) => tx<[Row]>`SELECT ${new Uint64(42n)} AS id`
)
assert.equal(taggedSession[0]?.[0]?.id, 42n)
assert.equal(taggedTransaction[0]?.[0]?.id, 42n)
console.log('tagged query, do, begin on the same client = 42')
