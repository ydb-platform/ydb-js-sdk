// eslint-disable no-await-in-loop
import { entityKind } from 'drizzle-orm/entity'
import { TransactionRollbackError } from 'drizzle-orm/errors'
import { type Logger, NoopLogger } from 'drizzle-orm/logger'
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations'
import type { QueryWithTypings, SQL, SQLWrapper } from 'drizzle-orm/sql/sql'
import type { YdbDialect } from '../ydb/dialect.js'
import { mapYdbQueryError } from '../ydb/errors.js'
import type {
	YdbExecuteOptions,
	YdbExecutor,
	YdbQueryResult,
	YdbTransactionalExecutor,
} from '../ydb/driver.js'
import type { YdbTransactionConfig } from '../ydb/driver.js'
import { type YdbSelectedFieldsOrdered, mapResultRow, rowToArray } from './result-mapping.js'
import type {
	YdbSchemaDefinition,
	YdbSchemaRelations,
	YdbSchemaWithoutTables,
} from './schema.types.js'
import { YdbTransaction } from './transaction.js'

export interface YdbPreparedQueryConfig {
	execute: unknown
	all: unknown
	get: unknown
	values: unknown
}

export interface YdbSessionOptions {
	logger?: Logger | undefined
}

type SelectedFieldsOrdered = YdbSelectedFieldsOrdered

export type YdbQuerySource = SQL | SQLWrapper | QueryWithTypings
export type YdbBatchQuery = YdbQuerySource | YdbPreparedQuery | YdbRunnablePreparedQuery

type YdbRunnablePreparedQuery = {
	prepare(name?: string): Pick<YdbPreparedQuery, 'execute' | 'all' | 'get' | 'values'>
}

function isQueryWithTypings(query: YdbQuerySource): query is QueryWithTypings {
	return 'sql' in query && 'params' in query && Array.isArray(query.params)
}

function isRunnablePreparedQuery(query: unknown): query is SQLWrapper & YdbRunnablePreparedQuery {
	return (
		!!query &&
		typeof query === 'object' &&
		'prepare' in query &&
		typeof query.prepare === 'function'
	)
}

function supportsTransactions(
	client: YdbExecutor | YdbTransactionalExecutor
): client is YdbTransactionalExecutor {
	return 'transaction' in client && typeof client.transaction === 'function'
}

function normalizeQuery(query: YdbQuerySource, dialect: YdbDialect): QueryWithTypings {
	if (isQueryWithTypings(query)) {
		return query as QueryWithTypings
	}

	return dialect.sqlToQuery(query.getSQL())
}

function findTransactionRollbackError(error: unknown): TransactionRollbackError | undefined {
	let current = error

	while (current instanceof Error) {
		if (current instanceof TransactionRollbackError) {
			return current
		}

		current = current.cause
	}

	return undefined
}

function attachResultMeta(rows: unknown[], result: YdbQueryResult): unknown[] {
	Object.defineProperties(rows, {
		rowCount: {
			configurable: true,
			enumerable: false,
			value: result.rowCount,
		},
		command: {
			configurable: true,
			enumerable: false,
			value: result.command,
		},
		meta: {
			configurable: true,
			enumerable: false,
			value: result.meta,
		},
	})

	return rows
}

export class YdbPreparedQuery<T extends YdbPreparedQueryConfig = YdbPreparedQueryConfig> {
	static readonly [entityKind] = 'YdbPreparedQuery'

	constructor(
		private readonly client: YdbExecutor,
		private readonly query: QueryWithTypings,
		private readonly logger: Logger,
		private readonly fields: SelectedFieldsOrdered | undefined,
		private readonly responseInArrayMode: boolean,
		private readonly customResultMapper?: (
			rows: unknown[][],
			mapColumnValue?: (value: unknown) => unknown
		) => T['execute']
	) {}

	getQuery(): QueryWithTypings {
		return this.query
	}

	isResponseInArrayMode(): boolean {
		return this.responseInArrayMode
	}

	mapResult(response: unknown, _isFromBatch?: boolean): unknown {
		if (!Array.isArray(response)) {
			return response
		}

		if (this.customResultMapper) {
			const rows = this.fields
				? response.map((row) => rowToArray(this.fields as any, row as any))
				: (response as unknown[][])
			return this.customResultMapper(rows as unknown[][], (value) => value)
		}

		if (!this.fields) {
			return response
		}

		return (response as Array<unknown[] | Record<string, unknown>>).map((row) =>
			mapResultRow(this.fields as any, row, undefined)
		)
	}

	private async run(method: 'execute' | 'all', arrayMode: boolean): Promise<unknown[]> {
		const options: YdbExecuteOptions = {
			arrayMode,
		}
		if (this.query.typings !== undefined) {
			options.typings = this.query.typings
		}

		this.logger.logQuery(this.query.sql, this.query.params)
		try {
			const result = await this.client.execute(
				this.query.sql,
				this.query.params,
				method,
				options
			)
			return attachResultMeta(result.rows, result)
		} catch (error) {
			throw mapYdbQueryError(this.query.sql, this.query.params, error)
		}
	}

	async execute(): Promise<T['execute']> {
		const rows = await this.run('execute', this.responseInArrayMode)
		return this.mapResult(rows) as T['execute']
	}

	async all(): Promise<T['all']> {
		const rows = await this.run('all', this.responseInArrayMode)
		return this.mapResult(rows) as T['all']
	}

	async get(): Promise<T['get']> {
		const rows = await this.run('all', this.responseInArrayMode)
		const result = this.mapResult(rows)
		return (Array.isArray(result) ? result[0] : result) as T['get']
	}

	async values(): Promise<T['values']> {
		const rows = await this.run('all', true)
		return rows as T['values']
	}
}

export class YdbSession {
	static readonly [entityKind] = 'YdbSession'
	private readonly logger: Logger

	constructor(
		private readonly client: YdbExecutor | YdbTransactionalExecutor,
		private readonly dialect: YdbDialect,
		options: YdbSessionOptions = {}
	) {
		this.logger = options.logger ?? new NoopLogger()
	}

	prepareQuery<T extends YdbPreparedQueryConfig = YdbPreparedQueryConfig>(
		query: YdbQuerySource,
		fields: SelectedFieldsOrdered | undefined,
		_name?: string,
		isResponseInArrayMode = false,
		customResultMapper?: (
			rows: unknown[][],
			mapColumnValue?: (value: unknown) => unknown
		) => T['execute']
	): YdbPreparedQuery<T> {
		return new YdbPreparedQuery<T>(
			this.client,
			normalizeQuery(query, this.dialect),
			this.logger,
			fields,
			isResponseInArrayMode,
			customResultMapper
		)
	}

	async execute<T = unknown>(query: YdbQuerySource, options?: YdbExecuteOptions): Promise<T> {
		if (isRunnablePreparedQuery(query)) {
			return query.prepare().execute() as Promise<T>
		}

		const prepared = this.prepareQuery<YdbPreparedQueryConfig & { execute: T }>(
			query,
			undefined,
			undefined,
			false
		)
		if (options?.arrayMode === true) {
			return prepared.values() as Promise<T>
		}
		return prepared.execute() as Promise<T>
	}

	async all<T = unknown>(query: YdbQuerySource, options?: YdbExecuteOptions): Promise<T[]> {
		if (isRunnablePreparedQuery(query)) {
			return query.prepare().all() as Promise<T[]>
		}

		const prepared = this.prepareQuery<YdbPreparedQueryConfig & { all: T[] }>(
			query,
			undefined,
			undefined,
			false
		)
		if (options?.arrayMode === true) {
			return prepared.values() as Promise<T[]>
		}
		return prepared.all() as Promise<T[]>
	}

	async get<T = unknown>(query: YdbQuerySource): Promise<T> {
		if (isRunnablePreparedQuery(query)) {
			return query.prepare().get() as Promise<T>
		}

		return this.prepareQuery<YdbPreparedQueryConfig & { get: T }>(
			query,
			undefined,
			undefined,
			false
		).get()
	}

	async values<T extends unknown[] = unknown[]>(query: YdbQuerySource): Promise<T[]> {
		if (isRunnablePreparedQuery(query)) {
			return query.prepare().values() as Promise<T[]>
		}

		return this.prepareQuery<YdbPreparedQueryConfig & { values: T[] }>(
			query,
			undefined,
			undefined,
			true
		).values()
	}

	async batch<T extends readonly YdbBatchQuery[]>(
		queries: T
	): Promise<{ [K in keyof T]: unknown }> {
		const results: unknown[] = []

		for (const query of queries) {
			if (query instanceof YdbPreparedQuery) {
				results.push(await query.execute())
				continue
			}

			if (isRunnablePreparedQuery(query)) {
				results.push(await query.prepare().execute())
				continue
			}

			results.push(await this.execute(query as YdbQuerySource))
		}

		return results as { [K in keyof T]: unknown }
	}

	async count(query: YdbQuerySource): Promise<number> {
		const rows = await this.values<[number | bigint | string]>(query)
		const value = rows[0]?.[0]
		return Number(value ?? 0)
	}

	async transaction<T>(
		transaction: (tx: YdbTransaction) => Promise<T>,
		config?: YdbTransactionConfig
	): Promise<T>
	async transaction<
		T,
		TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
		TSchemaRelations extends TablesRelationalConfig = YdbSchemaRelations<TSchemaDefinition>,
	>(
		transaction: (tx: YdbTransaction<TSchemaDefinition, TSchemaRelations>) => Promise<T>,
		config: YdbTransactionConfig | undefined,
		schema: RelationalSchemaConfig<TSchemaRelations> | undefined
	): Promise<T>
	async transaction<
		T,
		TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
		TSchemaRelations extends TablesRelationalConfig = YdbSchemaRelations<TSchemaDefinition>,
	>(
		transaction: (tx: YdbTransaction<TSchemaDefinition, TSchemaRelations>) => Promise<T>,
		config?: YdbTransactionConfig,
		schema?: RelationalSchemaConfig<TSchemaRelations>
	): Promise<T> {
		if (!supportsTransactions(this.client)) {
			throw new Error('Transactions are not supported')
		}

		try {
			return await this.client.transaction(async (txClient) => {
				const session = new YdbSession(txClient, this.dialect, { logger: this.logger })
				const tx = new YdbTransaction<TSchemaDefinition, TSchemaRelations>(
					this.dialect,
					session,
					schema
				)
				return transaction(tx)
			}, config)
		} catch (error) {
			const rollbackError = findTransactionRollbackError(error)
			if (rollbackError) {
				throw rollbackError
			}

			throw error
		}
	}
}
