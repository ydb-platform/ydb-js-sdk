import { test } from 'vitest'
import assert from 'node:assert/strict'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { DrizzleQueryError, TransactionRollbackError } from 'drizzle-orm/errors'
import { sql as yql } from 'drizzle-orm'
import {
	YdbAuthenticationError,
	YdbCancelledQueryError,
	YdbOverloadedQueryError,
	YdbRetryableQueryError,
	YdbTimeoutQueryError,
	YdbUnavailableQueryError,
	YdbUniqueConstraintViolationError,
	customType,
	drizzle,
	integer,
	text,
	ydbTable,
} from '../../src/index.ts'
import { YdbDialect } from '../../src/ydb/dialect.ts'
import { YdbSession } from '../../src/ydb-core/session.ts'
import { orderSelectedFields } from '../../src/ydb-core/result-mapping.ts'

let dialect = new YdbDialect()
let users = ydbTable('users', {
	id: integer('id').notNull(),
	name: text('name').notNull(),
})

test('prepareQuery', () => {
	let logs: Array<{ query: string; params: unknown[] }> = []
	let session = new YdbSession(
		{
			async execute() {
				return { rows: [] }
			},
		},
		dialect,
		{
			logger: {
				logQuery(query, params) {
					logs.push({ query, params: [...params] })
				},
			},
		}
	)

	let fields = orderSelectedFields({ id: users.id, name: users.name })
	let prepared = session.prepareQuery(
		yql`select ${1} as ${yql.identifier('id')}`,
		fields,
		'select_users',
		true,
		(rows) => rows.length
	)

	assert.equal(prepared.getQuery().sql, 'select $p0 as `id`')
	assert.deepEqual(prepared.getQuery().params, [1])
	assert.equal(prepared.isResponseInArrayMode(), true)
	assert.equal(prepared.mapResult([[1, 'Twilight']]), 1)
	assert.deepEqual(logs, [])
})

test('prepared rows', async () => {
	let logs: Array<{ query: string; params: unknown[] }> = []
	let calls: Array<{ method: string; options: unknown }> = []
	let fields = orderSelectedFields({ id: users.id, name: users.name })
	let session = new YdbSession(
		{
			async execute(_query, _params, method, options) {
				calls.push({ method, options })
				return { rows: [[1, 'Twilight Sparkle']] }
			},
		},
		dialect,
		{
			logger: {
				logQuery(query, params) {
					logs.push({ query, params: [...params] })
				},
			},
		}
	)

	let prepared = session.prepareQuery(
		yql`select ${1} as id, ${'Twilight Sparkle'} as name`,
		fields,
		undefined,
		false
	)

	let allRows = await prepared.all()
	let oneRow = await prepared.get()
	let valueRows = await prepared.values()

	assert.deepEqual(allRows, [{ id: 1, name: 'Twilight Sparkle' }])
	assert.deepEqual(oneRow, { id: 1, name: 'Twilight Sparkle' })
	assert.deepEqual(valueRows, [[1, 'Twilight Sparkle']])
	assert.equal(calls.length, 3)
	assert.deepEqual(
		calls.map(({ method }) => method),
		['all', 'all', 'all']
	)
	assert.equal(logs.length, 3)
	assert.ok(logs.every(({ query }) => query === 'select $p0 as id, $p1 as name'))
})

test('prepared execute', async () => {
	let session = new YdbSession(
		{
			async execute(_query, _params, method, options) {
				return {
					rows: options?.arrayMode ? [[1, 'Rarity']] : [{ id: 1, name: 'Rarity' }],
					rowCount: 1,
					command: method,
					meta: { arrayMode: options?.arrayMode === true },
				}
			},
		},
		dialect
	)

	let rawPrepared = session.prepareQuery(yql`select ${1}`, undefined, undefined, false)
	let arrayPrepared = session.prepareQuery(yql`select ${1}`, undefined, undefined, true)

	assert.deepEqual(await rawPrepared.execute(), [{ id: 1, name: 'Rarity' }])
	type RowsWithMeta = unknown[][] & {
		rowCount?: number
		command?: string
		meta?: { arrayMode: boolean }
	}
	let arrayRows: RowsWithMeta = (await arrayPrepared.execute()) as any

	assert.equal(arrayRows.rowCount, 1)
	assert.equal(arrayRows.command, 'execute')
	assert.deepEqual(arrayRows.meta, { arrayMode: true })
	assert.deepEqual(arrayRows, [[1, 'Rarity']])
})

test('prepared query errors preserve query context and map unique constraint failures', async () => {
	let uniqueCause = new Error('Unique constraint violation: duplicate key users_email_unique')
	let uniqueSession = new YdbSession(
		{
			async execute() {
				throw uniqueCause
			},
		},
		dialect
	)

	await assert.rejects(
		() => uniqueSession.prepareQuery(yql`insert into users values (${1})`).execute(),
		(error) => {
			assert.ok(error instanceof YdbUniqueConstraintViolationError)
			assert.equal(error.query, 'insert into users values ($p0)')
			assert.deepEqual(error.params, [1])
			assert.equal(error.cause, uniqueCause)
			return true
		}
	)

	let genericCause = new Error('YDB unavailable')
	let genericSession = new YdbSession(
		{
			async execute() {
				throw genericCause
			},
		},
		dialect
	)

	await assert.rejects(
		() => genericSession.prepareQuery(yql`select ${1}`).execute(),
		(error) => {
			assert.ok(error instanceof DrizzleQueryError)
			assert.ok(!(error instanceof YdbUniqueConstraintViolationError))
			assert.equal(error.query, 'select $p0')
			assert.deepEqual(error.params, [1])
			assert.equal(error.cause, genericCause)
			return true
		}
	)
})

test('prepared query errors inspect YDB issue payloads for unique violations', async () => {
	let ydbCause = Object.assign(new Error('PRECONDITION_FAILED'), {
		code: StatusIds_StatusCode.PRECONDITION_FAILED,
		issues: [
			{
				message: 'Conflict with unique index users_email_unique',
			},
		],
	})
	let session = new YdbSession(
		{
			async execute() {
				throw ydbCause
			},
		},
		dialect
	)

	await assert.rejects(
		() => session.prepareQuery(yql`insert into users values (${1})`).execute(),
		(error) => {
			assert.ok(error instanceof YdbUniqueConstraintViolationError)
			assert.equal(error.query, 'insert into users values ($p0)')
			assert.deepEqual(error.params, [1])
			assert.equal(error.cause, ydbCause)
			return true
		}
	)
})

test('prepared query errors map common YDB runtime failures to typed errors', async () => {
	let cases = [
		{
			name: 'auth',
			cause: Object.assign(new Error('UNAUTHORIZED'), {
				code: StatusIds_StatusCode.UNAUTHORIZED,
			}),
			errorClass: YdbAuthenticationError,
			kind: 'authentication',
			retryable: false,
		},
		{
			name: 'cancelled',
			cause: Object.assign(new Error('CANCELLED'), {
				code: StatusIds_StatusCode.CANCELLED,
			}),
			errorClass: YdbCancelledQueryError,
			kind: 'cancelled',
			retryable: false,
		},
		{
			name: 'timeout',
			cause: Object.assign(new Error('TIMEOUT'), {
				code: StatusIds_StatusCode.TIMEOUT,
			}),
			errorClass: YdbTimeoutQueryError,
			kind: 'timeout',
			retryable: true,
		},
		{
			name: 'unavailable',
			cause: Object.assign(new Error('UNAVAILABLE'), {
				code: StatusIds_StatusCode.UNAVAILABLE,
			}),
			errorClass: YdbUnavailableQueryError,
			kind: 'unavailable',
			retryable: true,
		},
		{
			name: 'overloaded',
			cause: Object.assign(new Error('OVERLOADED'), {
				code: StatusIds_StatusCode.OVERLOADED,
			}),
			errorClass: YdbOverloadedQueryError,
			kind: 'overloaded',
			retryable: true,
		},
		{
			name: 'retryable',
			cause: Object.assign(new Error('ABORTED'), {
				code: StatusIds_StatusCode.ABORTED,
			}),
			errorClass: YdbRetryableQueryError,
			kind: 'retryable',
			retryable: true,
		},
	] as const

	await Promise.all(
		cases.map(async (item) => {
			let session = new YdbSession(
				{
					async execute() {
						throw item.cause
					},
				},
				dialect
			)

			await assert.rejects(
				() => session.prepareQuery(yql`select ${item.name}`).execute(),
				(error) => {
					assert.ok(error instanceof item.errorClass)
					if (item.retryable) {
						assert.ok(error instanceof YdbRetryableQueryError)
					}
					assert.equal((error as any).kind, item.kind)
					assert.equal((error as any).retryable, item.retryable)
					assert.equal((error as any).statusCode, item.cause.code)
					assert.equal((error as any).code, item.cause.code)
					assert.equal(error.cause, item.cause)
					return true
				}
			)
		})
	)
})

test('prepared query errors classify grpc-shaped retryable failures', async () => {
	let cause = Object.assign(new Error('deadline exceeded'), {
		code: 4,
	})
	let session = new YdbSession(
		{
			async execute() {
				throw cause
			},
		},
		dialect
	)

	await assert.rejects(
		() => session.prepareQuery(yql`select ${1}`).execute(),
		(error) => {
			assert.ok(error instanceof YdbTimeoutQueryError)
			assert.ok(error instanceof YdbRetryableQueryError)
			assert.equal((error as any).kind, 'timeout')
			assert.equal((error as any).retryable, true)
			assert.equal((error as any).statusCode, 4)
			return true
		}
	)
})

test('prepared query errors preserve YDB diagnostic fields on Drizzle errors', async () => {
	let issues = [
		{
			message: 'BATCH operations are not supported at the current time.',
		},
	]
	let ydbCause = Object.assign(new Error('PRECONDITION_FAILED'), {
		code: StatusIds_StatusCode.PRECONDITION_FAILED,
		issues,
		retryable: false,
	})
	let session = new YdbSession(
		{
			async execute() {
				throw ydbCause
			},
		},
		dialect
	)

	await assert.rejects(
		() => session.prepareQuery(yql`select ${1}`).execute(),
		(error) => {
			assert.ok(error instanceof DrizzleQueryError)
			assert.equal((error as any).code, StatusIds_StatusCode.PRECONDITION_FAILED)
			assert.equal((error as any).issues, issues)
			assert.equal((error as any).retryable, false)
			assert.equal(error.cause, ydbCause)
			return true
		}
	)
})

test('prepared get', async () => {
	let session = new YdbSession(
		{
			async execute() {
				return { rows: [[1, 'Pinkie Pie']] }
			},
		},
		dialect
	)

	let prepared = session.prepareQuery(
		yql`select ${1} as id, ${'Pinkie Pie'} as name`,
		orderSelectedFields({ id: users.id, name: users.name }),
		undefined,
		true,
		(rows) => ({ id: rows[0]?.[0], name: rows[0]?.[1] })
	)

	assert.deepEqual(await prepared.get(), { id: 1, name: 'Pinkie Pie' })
})

test('prepared rows decode object results with column codecs', async () => {
	let slugType = customType<{ data: string; driverData: string }>({
		dataType() {
			return 'Utf8'
		},
		fromDriver(value) {
			return value.toLowerCase()
		},
	})
	let customUsers = ydbTable('custom_users', {
		id: integer('id').notNull(),
		slug: slugType('slug').notNull(),
	})
	let fields = orderSelectedFields({ id: customUsers.id, slug: customUsers.slug })
	let session = new YdbSession(
		{
			async execute() {
				return { rows: [{ id: 1, slug: 'RAINBOW-DASH' }] }
			},
		},
		dialect
	)

	let prepared = session.prepareQuery(yql.raw('select 1'), fields, undefined, false)

	assert.deepEqual(await prepared.all(), [{ id: 1, slug: 'rainbow-dash' }])
})

test('prepareQuery passes ordered rows and mapColumnValue to customResultMapper', async () => {
	let fields = orderSelectedFields({ id: users.id, name: users.name })
	let session = new YdbSession(
		{
			async execute() {
				return { rows: [{ id: 1, name: 'Fluttershy' }] }
			},
		},
		dialect
	)

	let prepared = session.prepareQuery(
		yql.raw('select 1'),
		fields,
		undefined,
		false,
		(rows, mapColumnValue) => ({
			rows,
			mapped: mapColumnValue?.('Fluttershy'),
		})
	)

	assert.deepEqual(await prepared.execute(), {
		rows: [[1, 'Fluttershy']],
		mapped: 'Fluttershy',
	})
})

test('session helpers', async () => {
	let calls: Array<{ method: string; arrayMode?: boolean; query: string }> = []
	let rowsQuery = yql`select ${7} as ${yql.identifier('id')}, ${'Applejack'} as ${yql.identifier('name')}`
	let countQuery = yql`select count(*) as ${yql.identifier('count')} from ${yql.identifier('users')}`
	let session = new YdbSession(
		{
			async execute(query, _params, method, options) {
				calls.push({ method, arrayMode: options?.arrayMode, query })

				if (query.includes('count')) {
					return { rows: [[3]] }
				}

				if (options?.arrayMode) {
					return { rows: [[7, 'Applejack']] }
				}

				return { rows: [{ id: 7, name: 'Applejack' }] }
			},
		},
		dialect
	)

	let executeResult = await session.execute(rowsQuery)
	let allResult = await session.all(rowsQuery)
	let getResult = await session.get(rowsQuery)
	let valuesResult = await session.values(rowsQuery)
	let countResult = await session.count(countQuery)

	assert.deepEqual(executeResult, [{ id: 7, name: 'Applejack' }])
	assert.deepEqual(allResult, [{ id: 7, name: 'Applejack' }])
	assert.deepEqual(getResult, { id: 7, name: 'Applejack' })
	assert.deepEqual(valuesResult, [[7, 'Applejack']])
	assert.equal(countResult, 3)
	assert.deepEqual(
		calls.map(({ method, arrayMode }) => ({ method, arrayMode })),
		[
			{ method: 'execute', arrayMode: false },
			{ method: 'all', arrayMode: false },
			{ method: 'all', arrayMode: false },
			{ method: 'all', arrayMode: true },
			{ method: 'all', arrayMode: true },
		]
	)
})

test('session helpers with builders', async () => {
	let db = drizzle({
		async execute(query, _params, _method, options) {
			if (query.startsWith('insert into `users`')) {
				return { rows: [] }
			}

			if (options?.arrayMode) {
				return { rows: [[1, 'Rainbow Dash']] }
			}

			return { rows: [[1, 'Rainbow Dash']] }
		},
	})

	let selectBuilder = db
		.select()
		.from(users)
		.where(yql`${users.id} = ${1}`)
	let insertBuilder = db.insert(users).values({ id: 1, name: 'Rainbow Dash' })

	assert.deepEqual(await db.execute<Array<{ id: number; name: string }>>(selectBuilder), [
		{ id: 1, name: 'Rainbow Dash' },
	])
	assert.deepEqual(await db.all<{ id: number; name: string }>(selectBuilder), [
		{ id: 1, name: 'Rainbow Dash' },
	])
	assert.deepEqual(await db.get<{ id: number; name: string }>(selectBuilder), {
		id: 1,
		name: 'Rainbow Dash',
	})
	assert.deepEqual(await db.values<[number, string]>(selectBuilder), [[1, 'Rainbow Dash']])
	assert.deepEqual(await db.execute(insertBuilder), [])
})

test('session transaction', async () => {
	let transactionConfigs: unknown[] = []
	let sessionWithoutTransactions = new YdbSession(
		{
			async execute() {
				return { rows: [] }
			},
		},
		dialect
	)

	await assert.rejects(
		() => sessionWithoutTransactions.transaction(async () => 'nope'),
		/Transactions are not supported/
	)

	let session = new YdbSession(
		{
			async execute() {
				return { rows: [] }
			},
			async transaction(callback, config) {
				transactionConfigs.push(config)

				try {
					return await callback({
						async execute() {
							return { rows: [] }
						},
					})
				} catch (error) {
					throw new Error('wrapped', { cause: error })
				}
			},
		},
		dialect
	)

	let committed = await session.transaction(
		async (tx) => {
			await tx.execute(yql`select ${1}`)
			return 'ok'
		},
		{ accessMode: 'read only' }
	)

	assert.equal(committed, 'ok')
	assert.deepEqual(transactionConfigs, [{ accessMode: 'read only' }])

	await assert.rejects(
		() =>
			session.transaction(async (tx) => {
				tx.rollback()
			}),
		TransactionRollbackError
	)
})
