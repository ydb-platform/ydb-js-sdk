import type { Driver } from '@ydbjs/core'
import {
	QueryClient,
	type QueryResult,
	type QueryStream,
	type SQLClient,
	query,
} from '@ydbjs/query'

declare let driver: Driver
let client = new QueryClient(driver)
let tagged: SQLClient = query(driver)
let shared: SQLClient = query(client)
let result: Promise<QueryResult<{ id: bigint }>> = client.retrySession((session) =>
	session.execute<{ id: bigint }>('SELECT id')
)
void [tagged, shared, result]

// @ts-expect-error Statements require an SDK-owned callback scope.
client.execute('SELECT id')
// @ts-expect-error The raw client uses retrySession for callback scopes.
client.do(async () => {})
// @ts-expect-error The raw client uses retryTransaction for transactions.
client.transaction(async () => {})
// @ts-expect-error Streaming requires an SDK-owned callback scope.
client.stream('SELECT id')
// @ts-expect-error Stream construction belongs to the client.
let invalidStream = new QueryStream()
void invalidStream

void client.retrySession(async (session, signal) => {
	let stream: QueryStream<{ id: bigint }> = session.stream<{ id: bigint }>('SELECT id')
	void stream
	await session.execute('SELECT id', {}, { signal, timeout: 1000 })
	// @ts-expect-error The surrounding callback owns the retry policy.
	await session.execute('SELECT id', {}, { idempotent: true })
	// @ts-expect-error The surrounding callback owns the retry policy.
	await session.execute('SELECT id', {}, { retry: { budget: 2 } })
	// @ts-expect-error The surrounding callback owns retry notifications.
	await session.execute('SELECT id', {}, { onRetry: () => {} })
	// @ts-expect-error Streams inherit retry ownership from the callback.
	session.stream('SELECT id', {}, { retry: { budget: 2 } })
})

void client.retryTransaction(async (transaction, signal) => {
	transaction.beforeCommit(async () => {})
	await transaction.execute('SELECT id', {}, { signal, timeout: 1000 })
	// @ts-expect-error Isolation is fixed by the surrounding transaction.
	await transaction.execute('SELECT id', {}, { isolation: 'snapshotReadOnly' })
	// @ts-expect-error The surrounding transaction owns the retry policy.
	await transaction.execute('SELECT id', {}, { idempotent: true })
})

void client.retrySession({ idempotent: true, retry: { budget: 2 } }, async () => {})
void client.retryTransaction({ isolation: 'snapshotReadOnly' }, async () => {})
// @ts-expect-error The callback must follow the operation options.
void client.retrySession(async () => {}, { idempotent: true })
// @ts-expect-error The callback must follow the operation options.
void client.retryTransaction(async () => {}, { isolation: 'snapshotReadOnly' })

void tagged.do(async (signal) => tagged`SELECT 1`.signal(signal))
void tagged.do({ idempotent: true }, async (signal) => tagged`SELECT 1`.signal(signal))
void tagged.begin(async (sql) => sql`SELECT 1`)
void tagged.transaction({ isolation: 'snapshotReadOnly' }, async (sql) => sql`SELECT 1`)
