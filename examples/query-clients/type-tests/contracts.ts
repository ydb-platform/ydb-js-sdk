import type { Driver } from '@ydbjs/core'
import {
	QueryClient,
	type QueryResult,
	type QueryStream,
	type SQLClient,
	query,
} from '@ydbjs/query'

type Row = { id: bigint }
type CountRow = { count: bigint }
type ValuesRow = [bigint, string]

declare let driver: Driver
let client = new QueryClient(driver)
let tagged: SQLClient = query(driver)
let shared: SQLClient = query(client)

let result: Promise<QueryResult<[Row]>> = client.retrySession((session) =>
	session.execute<[Row]>('SELECT id')
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

void client.retrySession(async (session) => {
	let single = await session.execute<[Row]>('SELECT id')

	let singleLength: 1 = single.resultSets.length
	let id: bigint = single.resultSets[0].rows[0]!.id
	let column: string | undefined = single.resultSets[0].columns[0]?.name
	let truncated: boolean = single.resultSets[0].truncated

	let multiple = await session.execute<[Row, CountRow]>('SELECT id; SELECT COUNT(*) AS count')

	let multipleLength: 2 = multiple.resultSets.length
	let count: bigint = multiple.resultSets[1].rows[0]!.count

	let values = await session.execute<[ValuesRow]>('SELECT id, name', {}, { rowMode: 'array' })

	let name: string = values.resultSets[0].rows[0]![1]
	void [singleLength, id, column, truncated, multipleLength, count, name]

	// @ts-expect-error A one-result tuple has no second result set.
	void single.resultSets[1]

	// @ts-expect-error The second result set contains CountRow values.
	void multiple.resultSets[1].rows[0]!.id

	// @ts-expect-error Result-set tuples preserve their arity.
	let wrongArity: QueryResult<[Row]> = multiple
	void wrongArity

	// @ts-expect-error execute takes a tuple of row types.
	await session.execute<Row>('SELECT id')

	// @ts-expect-error An unbounded row array does not declare the result-set tuple.
	await session.execute<Row[]>('SELECT id')
})

void client.retrySession(async (session, signal) => {
	let stream: QueryStream<Row> = session.stream<Row>('SELECT id')
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

	let rows: QueryResult<[Row]> = await transaction.execute<[Row]>(
		'SELECT id',
		{},
		{ signal, timeout: 1000 }
	)
	void rows

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

let untypedQuery = tagged`SELECT id`
let typedQuery = tagged<[Row]>`SELECT id`

let untypedThenable: PromiseLike<unknown[][]> = untypedQuery
let typedThenable: PromiseLike<unknown[][]> = typedQuery
let untypedPromise: Promise<unknown[][]> = Promise.resolve<unknown[][]>(untypedQuery)
let typedPromise: Promise<unknown[][]> = Promise.resolve<unknown[][]>(typedQuery)
let inferredPromise: Promise<[Row[]]> = Promise.resolve(typedQuery)
let forwardedPromise: Promise<[Row[]]> = typedQuery.then(null, null)
let transformedPromise: Promise<bigint> = typedQuery.then((rows) => rows[0][0]!.id, null)
let recoveredPromise: Promise<[Row[]] | number> = typedQuery.then(null, () => 0)
void [
	untypedThenable,
	typedThenable,
	untypedPromise,
	typedPromise,
	inferredPromise,
	forwardedPromise,
	transformedPromise,
	recoveredPromise,
]

void tagged.do(async (signal) => {
	let single = await tagged<[Row]>`SELECT id`.signal(signal)
	let multiple = await tagged<[Row, CountRow]>`
		SELECT id; SELECT COUNT(*) AS count
	`.signal(signal)

	let singleLength: 1 = single.length
	let multipleLength: 2 = multiple.length
	let id: bigint = single[0][0]!.id
	let count: bigint = multiple[1][0]!.count
	void [singleLength, multipleLength, id, count]

	// @ts-expect-error A one-result tuple has no second result set.
	void single[1]

	// @ts-expect-error The second result set contains CountRow values.
	void multiple[1][0]!.id

	// @ts-expect-error SQL tags take a tuple of row types.
	await tagged<Row>`SELECT id`

	// @ts-expect-error An unbounded row array does not declare the result-set tuple.
	await tagged<Row[]>`SELECT id`
})

void tagged.do(async (signal) => {
	let values = await tagged<[Row, CountRow]>`
		SELECT id; SELECT COUNT(*) AS count
	`
		.values()
		.signal(signal)

	let length: 2 = values.length
	void length

	// @ts-expect-error A two-result tuple has no third result set.
	void values[2]
})
