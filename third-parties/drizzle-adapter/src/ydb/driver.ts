import { DrizzleQueryError } from 'drizzle-orm/errors'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Driver, kRegisterLibrary } from '@ydbjs/core'
import { type OperationOptions, QueryClient, type QueryExecutor } from '@ydbjs/query'
import { snapshotValue } from '@ydbjs/query/internal'
import type { JSValue } from '@ydbjs/value'
import { mapYdbQueryError } from './errors.js'

import pkg from '../../package.json' with { type: 'json' }

export interface YdbTransactionConfig extends OperationOptions {
	accessMode?: 'read only' | 'read write' | undefined
	isolationLevel?: 'serializableReadWrite' | 'snapshotReadOnly' | undefined
}

export type YdbExecutionMethod = 'all' | 'execute'

export interface YdbExecuteOptions {
	arrayMode?: boolean | undefined
	typings?: unknown[] | undefined
}

export interface YdbQueryMeta {
	arrayMode: boolean
	typings?: unknown[] | undefined
}

export interface YdbQueryResult {
	rows: unknown[]
	rowCount?: number
	command?: YdbExecutionMethod
	meta?: YdbQueryMeta
}

export type YdbRemoteCallback = (
	sql: string,
	params: unknown[],
	method: YdbExecutionMethod,
	options?: YdbExecuteOptions
) => Promise<YdbQueryResult>

export interface YdbExecutor {
	execute(
		sql: string,
		params: unknown[],
		method: YdbExecutionMethod,
		options?: YdbExecuteOptions
	): Promise<YdbQueryResult>
	ready?(signal?: AbortSignal): Promise<void>
	close?(): Promise<void> | void
}

export interface YdbTransactionalExecutor extends YdbExecutor {
	transaction<T>(
		callback: (tx: YdbExecutor) => Promise<T>,
		config?: YdbTransactionConfig
	): Promise<T>
}

async function execQuery(
	executor: QueryExecutor,
	text: string,
	params: unknown[],
	method: YdbExecutionMethod,
	options?: YdbExecuteOptions
): Promise<YdbQueryResult> {
	let parameters: Record<string, JSValue> = Object.create(null)
	for (let i = 0; i < params.length; ++i) {
		parameters[`$p${i}`] = params[i] as JSValue
	}

	let arrayMode = options?.arrayMode === true
	let { resultSets } = await executor.execute(text, parameters, {
		rowMode: arrayMode ? 'array' : 'object',
	})

	if (resultSets.length > 1) {
		throw new Error(
			`YDB query returned ${resultSets.length} result sets, but the Drizzle adapter expects exactly one. ` +
				'Split the query so each call runs a single statement, or use the @ydbjs/query API directly for multi-result-set responses.'
		)
	}

	let rows = resultSets[0]?.rows ?? []

	return {
		rows,
		rowCount: rows.length,
		command: method,
		meta: { arrayMode, typings: options?.typings ? [...options.typings] : undefined },
	}
}

let transactions = new AsyncLocalStorage<ReadonlyMap<YdbExecutor, YdbTxExecutor>>()

class YdbTxExecutor implements YdbExecutor {
	#executor: QueryExecutor
	#errors?: WeakMap<Error, DrizzleQueryError>

	constructor(executor: QueryExecutor) {
		this.#executor = executor
	}

	execute(
		sql: string,
		params: unknown[],
		method: YdbExecutionMethod,
		options?: YdbExecuteOptions
	) {
		return execQuery(this.#executor, sql, params, method, options)
	}

	mapError(sql: string, params: unknown[], cause: unknown): DrizzleQueryError {
		let previous = this.statementError(cause)
		if (previous) {
			return previous
		}

		let error = mapYdbQueryError(sql, params, cause)
		if (cause instanceof Error) {
			this.#errors ??= new WeakMap()
			this.#errors.set(cause, error)
		}

		return error
	}

	statementCause(error: unknown): unknown {
		if (error instanceof DrizzleQueryError && this.statementError(error.cause) === error) {
			return error.cause
		}

		return error
	}

	statementError(cause: unknown): DrizzleQueryError | undefined {
		return cause instanceof Error ? this.#errors?.get(cause) : undefined
	}
}

export function mapStatementError(
	client: YdbExecutor,
	sql: string,
	params: unknown[],
	cause: unknown
) {
	let tx = client instanceof YdbTxExecutor ? client : transactions.getStore()?.get(client)
	return tx ? tx.mapError(sql, params, cause) : mapYdbQueryError(sql, params, cause)
}

export interface YdbDriverOptions {
	connectionString: string
}

export class YdbDriver implements YdbTransactionalExecutor {
	readonly driver: Driver
	#client: QueryClient
	#ownsDriver: boolean
	#ownsClient: boolean

	constructor(source: string | YdbDriverOptions | Driver | QueryClient) {
		this.#ownsClient = !(source instanceof QueryClient)
		this.#ownsDriver = this.#ownsClient && !(source instanceof Driver)

		if (source instanceof QueryClient) {
			this.driver = source.driver
		} else if (source instanceof Driver) {
			this.driver = source
		} else {
			this.driver = new Driver(typeof source === 'string' ? source : source.connectionString)
		}

		this.#client = source instanceof QueryClient ? source : new QueryClient(this.driver)
		this.driver[kRegisterLibrary]('@ydbjs/drizzle-adapter', pkg.version)
	}

	get client(): QueryClient {
		return this.#client
	}

	ready(signal?: AbortSignal): Promise<void> {
		return this.driver.ready(signal)
	}

	async execute(
		sql: string,
		params: unknown[],
		method: YdbExecutionMethod,
		options?: YdbExecuteOptions
	): Promise<YdbQueryResult> {
		let tx = transactions.getStore()?.get(this)
		if (tx) {
			return tx.execute(sql, params, method, options)
		}

		// A standalone statement must replay its original inputs even if the caller mutates them.
		let inputs = params.map((value) => {
			return snapshotValue(value as JSValue)
		})

		return this.client.retrySession((executor) => {
			return execQuery(executor, sql, inputs, method, options)
		})
	}

	async transaction<T>(
		callback: (tx: YdbExecutor) => Promise<T>,
		config?: YdbTransactionConfig
	): Promise<T> {
		let parent = transactions.getStore()
		if (parent?.has(this)) {
			throw new Error('Nested YDB transactions are not supported')
		}

		let { accessMode, isolationLevel, ...operation } = config ?? {}
		let isolation =
			isolationLevel ??
			(accessMode === 'read only' ? 'snapshotReadOnly' : 'serializableReadWrite')
		let attempt: YdbTxExecutor | undefined

		try {
			return await this.client.retryTransaction(
				{ ...operation, isolation },
				async (executor) => {
					let tx = new YdbTxExecutor(executor)
					attempt = tx

					try {
						return await transactions.run(new Map(parent).set(this, tx), callback, tx)
					} catch (error) {
						// The SDK classifies the original statement failure when deciding whether to replay the callback.
						throw tx.statementCause(error)
					}
				}
			)
		} catch (error) {
			throw attempt?.statementError(error) ?? error
		}
	}

	close(): void {
		if (this.#ownsClient) {
			this.client.destroy()
		}

		if (this.#ownsDriver) {
			this.driver.close()
		}
	}

	static fromCallback(callback: YdbRemoteCallback): YdbExecutor {
		return {
			execute(sql, params, method, options) {
				return callback(sql, params, method, options)
			},
		}
	}
}
