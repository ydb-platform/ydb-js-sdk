import { expect, test } from 'vitest'
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
	drizzle,
} from '../index.ts'
import { customType, integer, text, ydbTable } from '../schema.ts'
import { YdbDialect } from '../ydb/dialect.ts'
import { YdbSession } from '../ydb-core/session.ts'
import { orderSelectedFields } from '../ydb-core/result-mapping.ts'

let dialect = new YdbDialect()
let users = ydbTable('users', {
	id: integer('id').notNull(),
	name: text('name').notNull(),
})

test('normalises queries and builds YdbPreparedQuery', () => {
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

	expect(prepared.getQuery().sql).toBe('select $p0 as `id`')
	expect(prepared.getQuery().params).toEqual([1])
	expect(prepared.isResponseInArrayMode()).toBe(true)
	expect(prepared.mapResult([[1, 'Twilight']])).toBe(1)
	expect(logs).toEqual([])
})

test('returns prepared rows in array mode', async () => {
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

	expect(allRows).toEqual([{ id: 1, name: 'Twilight Sparkle' }])
	expect(oneRow).toEqual({ id: 1, name: 'Twilight Sparkle' })
	expect(valueRows).toEqual([[1, 'Twilight Sparkle']])
	expect(calls.length).toBe(3)
	expect(calls.map(({ method }) => method)).toEqual(['all', 'all', 'all'])
	expect(logs.length).toBe(3)
	expect(logs.every(({ query }) => query === 'select $p0 as id, $p1 as name')).toBe(true)
})

test('executes prepared queries against the client', async () => {
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

	expect(await rawPrepared.execute()).toEqual([{ id: 1, name: 'Rarity' }])
	type RowsWithMeta = unknown[][] & {
		rowCount?: number
		command?: string
		meta?: { arrayMode: boolean }
	}
	let arrayRows: RowsWithMeta = (await arrayPrepared.execute()) as any

	expect(arrayRows.rowCount).toBe(1)
	expect(arrayRows.command).toBe('execute')
	expect(arrayRows.meta).toEqual({ arrayMode: true })
	expect(arrayRows).toEqual([[1, 'Rarity']])
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

	let uniqueError: unknown
	try {
		await uniqueSession.prepareQuery(yql`insert into users values (${1})`).execute()
	} catch (error) {
		uniqueError = error
	}

	expect(uniqueError).toBeInstanceOf(YdbUniqueConstraintViolationError)
	expect((uniqueError as YdbUniqueConstraintViolationError).query).toBe(
		'insert into users values ($p0)'
	)
	expect((uniqueError as YdbUniqueConstraintViolationError).params).toEqual([1])
	expect((uniqueError as YdbUniqueConstraintViolationError).cause).toBe(uniqueCause)

	let genericCause = new Error('YDB unavailable')
	let genericSession = new YdbSession(
		{
			async execute() {
				throw genericCause
			},
		},
		dialect
	)

	let genericError: unknown
	try {
		await genericSession.prepareQuery(yql`select ${1}`).execute()
	} catch (error) {
		genericError = error
	}

	expect(genericError).toBeInstanceOf(DrizzleQueryError)
	expect(genericError).not.toBeInstanceOf(YdbUniqueConstraintViolationError)
	expect((genericError as DrizzleQueryError).query).toBe('select $p0')
	expect((genericError as DrizzleQueryError).params).toEqual([1])
	expect((genericError as DrizzleQueryError).cause).toBe(genericCause)
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

	let issueError: unknown
	try {
		await session.prepareQuery(yql`insert into users values (${1})`).execute()
	} catch (error) {
		issueError = error
	}

	expect(issueError).toBeInstanceOf(YdbUniqueConstraintViolationError)
	expect((issueError as YdbUniqueConstraintViolationError).query).toBe(
		'insert into users values ($p0)'
	)
	expect((issueError as YdbUniqueConstraintViolationError).params).toEqual([1])
	expect((issueError as YdbUniqueConstraintViolationError).cause).toBe(ydbCause)
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

			let caseError: unknown
			try {
				await session.prepareQuery(yql`select ${item.name}`).execute()
			} catch (error) {
				caseError = error
			}

			expect(caseError).toBeInstanceOf(item.errorClass)
			expect(caseError instanceof YdbRetryableQueryError).toBe(item.retryable)
			expect((caseError as any).kind).toBe(item.kind)
			expect((caseError as any).retryable).toBe(item.retryable)
			expect((caseError as any).statusCode).toBe(item.cause.code)
			expect((caseError as any).code).toBe(item.cause.code)
			expect((caseError as Error).cause).toBe(item.cause)
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

	let caughtError: unknown
	try {
		await session.prepareQuery(yql`select ${1}`).execute()
	} catch (error) {
		caughtError = error
	}

	expect(caughtError).toBeInstanceOf(YdbTimeoutQueryError)
	expect(caughtError).toBeInstanceOf(YdbRetryableQueryError)
	expect((caughtError as any).kind).toBe('timeout')
	expect((caughtError as any).retryable).toBe(true)
	expect((caughtError as any).statusCode).toBe(4)
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

	let caughtError: unknown
	try {
		await session.prepareQuery(yql`select ${1}`).execute()
	} catch (error) {
		caughtError = error
	}

	expect(caughtError).toBeInstanceOf(DrizzleQueryError)
	expect((caughtError as any).code).toBe(StatusIds_StatusCode.PRECONDITION_FAILED)
	expect((caughtError as any).issues).toBe(issues)
	expect((caughtError as any).retryable).toBe(false)
	expect((caughtError as Error).cause).toBe(ydbCause)
})

test('returns the first row from prepared get', async () => {
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

	expect(await prepared.get()).toEqual({ id: 1, name: 'Pinkie Pie' })
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

	expect(await prepared.all()).toEqual([{ id: 1, slug: 'rainbow-dash' }])
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

	expect(await prepared.execute()).toEqual({
		rows: [[1, 'Fluttershy']],
		mapped: 'Fluttershy',
	})
})

test('wires session helpers around prepareQuery', async () => {
	let calls: Array<{ method: string; arrayMode: boolean | undefined; query: string }> = []
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

	expect(executeResult).toEqual([{ id: 7, name: 'Applejack' }])
	expect(allResult).toEqual([{ id: 7, name: 'Applejack' }])
	expect(getResult).toEqual({ id: 7, name: 'Applejack' })
	expect(valuesResult).toEqual([[7, 'Applejack']])
	expect(countResult).toBe(3)
	expect(calls.map(({ method, arrayMode }) => ({ method, arrayMode }))).toEqual([
		{ method: 'execute', arrayMode: false },
		{ method: 'all', arrayMode: false },
		{ method: 'all', arrayMode: false },
		{ method: 'all', arrayMode: true },
		{ method: 'all', arrayMode: true },
	])
})

test('routes session helpers through runnable builders', async () => {
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

	expect(await db.execute<Array<{ id: number; name: string }>>(selectBuilder)).toEqual([
		{ id: 1, name: 'Rainbow Dash' },
	])
	expect(await db.all<{ id: number; name: string }>(selectBuilder)).toEqual([
		{ id: 1, name: 'Rainbow Dash' },
	])
	expect(await db.get<{ id: number; name: string }>(selectBuilder)).toEqual({
		id: 1,
		name: 'Rainbow Dash',
	})
	expect(await db.values<[number, string]>(selectBuilder)).toEqual([[1, 'Rainbow Dash']])
	expect(await db.execute(insertBuilder)).toEqual([])
})

test('runs transaction callbacks through session.transaction', async () => {
	let transactionConfigs: unknown[] = []
	let sessionWithoutTransactions = new YdbSession(
		{
			async execute() {
				return { rows: [] }
			},
		},
		dialect
	)

	await expect(sessionWithoutTransactions.transaction(async () => 'nope')).rejects.toThrow(
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

	expect(committed).toBe('ok')
	expect(transactionConfigs).toEqual([{ accessMode: 'read only' }])

	await expect(
		session.transaction(async (tx) => {
			tx.rollback()
		})
	).rejects.toThrow(TransactionRollbackError)
})
