import type { Driver } from '@ydbjs/core'
import { isRetryableError } from '@ydbjs/retry'

import {
	type OperationOptions,
	QueryClient,
	type QueryClientOptions,
	type QueryExecutor,
	type Transaction,
	type TransactionOptions,
} from './client.js'
import { Query } from './query.js'
import { ctx } from './ctx.js'
import { Fragment, UnsafeString, fragment, identifier, join, unsafe, yql } from './yql.js'

export type QueryOptions = QueryClientOptions

export type SQL = <T extends any[] = unknown[], P extends any[] = unknown[]>(
	strings: string | TemplateStringsArray,
	...values: P
) => Query<T>

export type RegisterPrecommitHook = (fn: () => Promise<void> | void) => void

export type TX = SQL & {
	nodeId: bigint
	sessionId: string
	transactionId: string
	onRollback: (fn: (error: unknown, signal?: AbortSignal) => Promise<void> | void) => void
	onCommit: (fn: (signal?: AbortSignal) => Promise<void> | void) => void
	onClose: (fn: (committed: boolean, signal?: AbortSignal) => Promise<void> | void) => void
}

interface SessionContextCallback<T> {
	(signal: AbortSignal): Promise<T>
}

type TransactionExecuteOptions = TransactionOptions

interface TransactionContextCallback<T> {
	(tx: TX, signal: AbortSignal): Promise<T>
}

export interface SQLClient extends SQL, AsyncDisposable, Disposable {
	close(): Promise<void>
	destroy(): void

	// unsafe<T extends any[] = unknown[], P extends { toString(): string }[] = []>(
	// 	strings: string | TemplateStringsArray,
	// 	...values: P
	// ): Query<T>

	do<T = unknown>(fn: SessionContextCallback<T>): Promise<T>
	do<T = unknown>(options: OperationOptions, fn: SessionContextCallback<T>): Promise<T>

	begin<T = unknown>(fn: TransactionContextCallback<T>): Promise<T>
	begin<T = unknown>(
		options: TransactionExecuteOptions,
		fn: TransactionContextCallback<T>
	): Promise<T>

	transaction<T = unknown>(fn: TransactionContextCallback<T>): Promise<T>
	transaction<T = unknown>(
		options: TransactionExecuteOptions,
		fn: TransactionContextCallback<T>
	): Promise<T>

	/**
	 * Create an UnsafeString that represents a DB identifier (table, column).
	 * When used in a query, the identifier will be escaped.
	 *
	 * **WARNING: This function does not offer any protection against SQL injections,
	 *            so you must validate any user input beforehand.**
	 *
	 * @example ```ts
	 * const query = sql`SELECT * FROM ${sql.identifier('my-table')}`;
	 * // 'SELECT * FROM `my-table`'
	 * ```
	 */
	identifier(value: string | { toString(): string }): UnsafeString

	/**
	 * Create a composable {@link Fragment} from a tagged template. A fragment is
	 * not executable — splice it into another query or {@link SQLClient.join}
	 * to build dynamic SQL while keeping values bound as parameters.
	 *
	 * @example ```ts
	 * const cond = sql.fragment`${sql.identifier('age')} > ${18}`
	 * sql`SELECT * FROM users WHERE ${cond}`
	 * ```
	 */
	fragment(strings: TemplateStringsArray, ...values: unknown[]): Fragment

	/**
	 * Create an UnsafeString that will be injected into the query as-is.
	 *
	 * WARNING: Use only with trusted SQL fragments (e.g., migrations) and never
	 * with user-provided input. Prefer parameters or {@link identifier} for
	 * dynamic values.
	 */
	unsafe(value: string | { toString(): string }): UnsafeString

	/**
	 * Combine fragments into one, interleaving a separator. Empty list → empty
	 * fragment; single fragment → no separator. A string separator is inserted
	 * as raw SQL.
	 *
	 * @example ```ts
	 * sql`... WHERE ${sql.join(conditions, ' AND ')}`
	 * ```
	 */
	join(fragments: readonly Fragment[], separator?: Fragment | string): Fragment
}

export function query(driver: Driver, options?: QueryOptions): SQLClient
export function query(client: QueryClient): SQLClient
export function query(source: Driver | QueryClient, clientOptions?: QueryOptions): SQLClient {
	let client = source instanceof QueryClient ? source : new QueryClient(source, clientOptions)

	function executorSQL(executor?: QueryExecutor): SQL {
		return function <T extends any[] = unknown[], P extends any[] = unknown[]>(
			strings: string | TemplateStringsArray,
			...values: P
		): Query<T> {
			let { text, params } = yql(strings, ...values)
			return new Query<T>(client, text, params, executor)
		}
	}

	function transactionSQL(transaction: Transaction): TX {
		return Object.assign(executorSQL(transaction), {
			nodeId: transaction.nodeId,
			sessionId: transaction.sessionId,
			transactionId: transaction.transactionId,
			onCommit: transaction.beforeCommit.bind(transaction),
			onRollback: transaction.onRollback.bind(transaction),
			onClose: transaction.onClose.bind(transaction),
		})
	}

	function transact<T>(callback: TransactionContextCallback<T>): Promise<T>
	function transact<T>(
		options: TransactionExecuteOptions,
		callback: TransactionContextCallback<T>
	): Promise<T>
	async function transact<T>(
		optionsOrCallback: TransactionExecuteOptions | TransactionContextCallback<T>,
		callback?: TransactionContextCallback<T>
	): Promise<T> {
		if (typeof optionsOrCallback === 'function' && callback !== undefined)
			throw new TypeError('Use transaction(options, callback) when passing options.')
		let options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
		let caller = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
		if (typeof caller !== 'function')
			throw new TypeError('transaction() requires an async callback.')
		let callbackFailed = false
		let callbackError: unknown
		return client
			.retryTransaction(options, (transaction, signal) =>
				ctx.run({ client, executor: transaction, signal }, async () => {
					callbackFailed = false
					try {
						return await caller(transactionSQL(transaction), signal)
					} catch (error) {
						callbackFailed = true
						callbackError = error
						throw error
					}
				})
			)
			.catch((error) => {
				if (
					callbackFailed &&
					error === callbackError &&
					!isRetryableError(error, options.idempotent)
				)
					throw new Error('Transaction failed.', { cause: error })
				throw error
			})
	}

	function run<T>(callback: SessionContextCallback<T>): Promise<T>
	function run<T>(options: OperationOptions, callback: SessionContextCallback<T>): Promise<T>
	async function run<T>(
		optionsOrCallback: OperationOptions | SessionContextCallback<T>,
		callback?: SessionContextCallback<T>
	): Promise<T> {
		if (typeof optionsOrCallback === 'function' && callback !== undefined)
			throw new TypeError('Use do(options, callback) when passing options.')
		let options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
		let caller = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
		if (typeof caller !== 'function') throw new TypeError('do() requires an async callback.')
		return client.retrySession(options, (executor, signal) =>
			ctx.run({ client, executor, signal }, () => caller(signal))
		)
	}

	return Object.assign(executorSQL(), {
		close: () => client.close(),
		destroy: () => client.destroy(),
		[Symbol.dispose]: () => client.destroy(),
		[Symbol.asyncDispose]: () => client.close(),
		do: run,
		begin: transact,
		transaction: transact,
		identifier,
		unsafe,
		fragment,
		join,
	})
}

export { type Query } from './query.js'
export { identifier, unsafe, UnsafeString, fragment, join, Fragment } from './yql.js'
export {
	type SessionPoolOptions,
	SessionPoolFullError,
	SessionPoolClosedError,
} from './session-pool.js'

export { QueryClient } from './client.js'
export { TransactionCompletionError } from '@ydbjs/error'
export type {
	QueryClientOptions,
	QueryParameters,
	QueryExecutor,
	QueryResult,
	QueryPart,
	QuerySummary,
	QueryStream,
	StatementOptions,
	TransactionStatementOptions,
	OperationOptions,
	TransactionOptions,
	Transaction,
	Isolation,
} from './client.js'
