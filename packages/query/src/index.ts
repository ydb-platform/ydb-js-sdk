import type { Abortable } from 'node:events'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition } from '@ydbjs/api/query'
import type { Driver } from '@ydbjs/core'
import { CommitError, YDBError } from '@ydbjs/error'
import { defaultRetryConfig, isRetryableError, retry } from '@ydbjs/retry'
import { loggers } from '@ydbjs/debug'

import { Query } from './query.js'
import { ctx } from './ctx.js'
import { UnsafeString, identifier, unsafe, yql } from './yql.js'

let dbg = loggers.query

export type SQL = <T extends any[] = unknown[], P extends any[] = unknown[]>(
	strings: string | TemplateStringsArray,
	...values: P
) => Query<T>

export type RegisterPrecommitHook = (fn: () => Promise<void> | void) => void;

export type TX = SQL & {
	nodeId: bigint
	sessionId: string
	transactionId: string
	registerPrecommitHook: RegisterPrecommitHook
}

interface SessionContextCallback<T> {
	(signal: AbortSignal): Promise<T>
}

interface TransactionExecuteOptions extends Abortable {
	isolation?: 'serializableReadWrite' | 'snapshotReadOnly'
	idempotent?: boolean
}

interface TransactionContextCallback<T> {
	(tx: TX, signal: AbortSignal): Promise<T>
}

export interface QueryClient extends SQL, AsyncDisposable {
	// unsafe<T extends any[] = unknown[], P extends { toString(): string }[] = []>(
	// 	strings: string | TemplateStringsArray,
	// 	...values: P
	// ): Query<T>

	do<T = unknown>(fn: SessionContextCallback<T>): Promise<T>
	do<T = unknown>(options: any, fn: SessionContextCallback<T>): Promise<T>

	begin<T = unknown>(fn: TransactionContextCallback<T>): Promise<T>
	begin<T = unknown>(options: TransactionExecuteOptions, fn: TransactionContextCallback<T>): Promise<T>

	transaction<T = unknown>(fn: TransactionContextCallback<T>): Promise<T>
	transaction<T = unknown>(options: TransactionExecuteOptions, fn: TransactionContextCallback<T>): Promise<T>

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
	 * Create an UnsafeString that will be injected into the query as-is.
	 *
	 * WARNING: Use only with trusted SQL fragments (e.g., migrations) and never
	 * with user-provided input. Prefer parameters or {@link identifier} for
	 * dynamic values.
	 */
	unsafe(value: string | { toString(): string }): UnsafeString
}

const doImpl = function <T = unknown>(): Promise<T> {
	throw new Error('Not implemented')
}

/**
 * Creates a query client for executing YQL queries and managing transactions.
 *
 * @param driver - The YDB driver instance used to communicate with the database.
 * @returns A `QueryClient` object that provides methods for executing queries and managing transactions.
 *
 * @remarks
 * The returned client provides a tagged template function for YQL queries, as well as transactional helpers.
 *
 * @example
 * ```typescript
 * const client = query(driver);
 * const result = await client`SELECT 1;`;
 * ```
 *
 * @example
 * ```typescript
 * await client.transaction(async (yql, signal) => {
 *   const res = await yql`SELECT * FROM users WHERE id = ${userId}`;
 *   // ...
 * });
 * ```
 *
 * @see {@link QueryClient}
 */
export function query(driver: Driver): QueryClient {
	function yqlQuery<P extends any[] = unknown[], T extends any[] = unknown[]>(strings: string | TemplateStringsArray, ...values: P): Query<T> {
		let { text, params } = yql(strings, ...values)
		dbg.log('creating query instance for text: %s', text)
		return ctx.run(ctx.getStore() ?? {}, () => new Query<T>(driver, text, params))
	}

	function txIml<T = unknown>(fn: TransactionContextCallback<T>): Promise<T>
	function txIml<T = unknown>(options: TransactionExecuteOptions, fn: TransactionContextCallback<T>): Promise<T>
	/**
	 * Executes a transactional operation with automatic session and transaction management,
	 * including retries on retryable errors.
	 *
	 * This function handles the lifecycle of a YDB session and transaction, including session creation,
	 * transaction begin, commit, and rollback. It also manages retries for retryable errors and ensures
	 * proper cleanup of resources. The transaction isolation level and idempotency can be configured.
	 *
	 * @template T The return type of the transactional operation.
	 * @param optOrFn - Either the transaction execution options or the transactional callback function.
	 *   If a function is provided as the first argument, it is used as the transactional callback and
	 *   default options are applied.
	 * @param fn - The transactional callback function, if options are provided as the first argument.
	 *   The callback receives a YQL query executor and an AbortSignal.
	 * @returns A promise that resolves with the result of the transactional operation.
	 * @throws {YDBError} If session creation, transaction begin, or commit fails.
	 * @throws {CommitError} If the transaction commit fails.
	 * @throws {Error} If a non-retryable error occurs during the transaction.
	 *
	 * @remarks
	 * - The function automatically retries the transaction on retryable errors if the operation is idempotent.
	 * - The session and transaction are automatically cleaned up after execution.
	 * - The transaction isolation level defaults to "serializableReadWrite" if not specified.
	 * - The function uses the driver's QueryServiceDefinition to interact with YDB.
	 */
	async function txIml<T = unknown>(optOrFn: TransactionExecuteOptions | TransactionContextCallback<T>, fn?: TransactionContextCallback<T>): Promise<T> {
		dbg.log('starting transaction')
		await driver.ready()
		let store = ctx.getStore() || {}
		let client = driver.createClient(QueryServiceDefinition)

		let caller = (typeof optOrFn === "function" ? optOrFn : fn)
		let options = typeof optOrFn === "function" ? ({} as TransactionExecuteOptions) : optOrFn
		options.isolation ??= "serializableReadWrite"
		options.idempotent = options.idempotent ?? false;

		return retry({
			...defaultRetryConfig,
			signal: options.signal,
			idempotent: true,
			onRetry: (ctx) => {
				dbg.log('retrying transaction, attempt %d, error: %O', ctx.attempt, ctx.error)
			}
		}, async (signal) => {
			dbg.log('creating session for transaction')
			let sessionResponse = await client.createSession({}, { signal })
			if (sessionResponse.status !== StatusIds_StatusCode.SUCCESS) {
				dbg.log('failed to create session, status: %d', sessionResponse.status)
				throw new YDBError(sessionResponse.status, sessionResponse.issues)
			}

			store.signal = signal
			store.nodeId = sessionResponse.nodeId
			store.sessionId = sessionResponse.sessionId

			client = driver.createClient(QueryServiceDefinition, sessionResponse.nodeId)

			let attachSession = client.attachSession({ sessionId: store.sessionId }, { signal })[Symbol.asyncIterator]()
			let attachSessionResult = await attachSession.next()
			if (attachSessionResult.value.status !== StatusIds_StatusCode.SUCCESS) {
				dbg.log('failed to attach session, status: %d', attachSessionResult.value.status)
				throw new YDBError(attachSessionResult.value.status, attachSessionResult.value.issues)
			}

			dbg.log('session %s created and attached', store.sessionId)

			let beginTransactionResult = await client.beginTransaction({
				sessionId: store.sessionId,
				txSettings: { txMode: { case: options.isolation!, value: {} } },
			}, { signal })
			if (beginTransactionResult.status !== StatusIds_StatusCode.SUCCESS) {
				dbg.log('failed to begin transaction, status: %d', beginTransactionResult.status)
				throw new YDBError(beginTransactionResult.status, beginTransactionResult.issues)
			}

			store.transactionId = beginTransactionResult.txMeta!.id

			try {
				let precommitHooks: Array<() => Promise<void> | void> = []
				let tx = Object.assign(yqlQuery, {
					nodeId: store.nodeId,
					sessionId: store.sessionId,
					transactionId: store.transactionId,
					registerPrecommitHook: (fn: () => Promise<void> | void) => {
						precommitHooks.push(fn);
					},
				}) as TX

				dbg.log('executing transaction body')
				let result = await ctx.run(store, () => caller!(tx, signal))

				dbg.log('executing %d precommit hooks', precommitHooks.length)
				await Promise.all(precommitHooks.map(async (hook, i) => {
					dbg.log('executing precommit hook #%d', i + 1)
					await hook()
					dbg.log('precommit hook #%d completed', i + 1)
				}))

				dbg.log('committing transaction')
				let commitResult = await client.commitTransaction({ sessionId: store.sessionId, txId: store.transactionId }, { signal })
				if (commitResult.status !== StatusIds_StatusCode.SUCCESS) {
					dbg.log('failed to commit transaction, status: %d', commitResult.status)
					throw new CommitError("Transaction commit failed.", new YDBError(commitResult.status, commitResult.issues))
				}

				dbg.log('transaction committed successfully')
				return result
			} catch (error) {
				dbg.log('transaction error: %O', error)
				void client.rollbackTransaction({ sessionId: store.sessionId, txId: store.transactionId })

				if (!isRetryableError(error, options.idempotent)) {
					dbg.log('transaction not retryable, aborting')
					throw new Error("Transaction failed.", { cause: error })
				}

				throw error
			} finally {
				dbg.log('deleting session %s', sessionResponse.sessionId)
				void client.deleteSession({ sessionId: sessionResponse.sessionId })
			}
		})
	}

	return Object.assign(yqlQuery,
		{
			do: doImpl,
			begin: txIml,
			transaction: txIml,
			identifier: identifier,
			unsafe: unsafe,
			async [Symbol.asyncDispose]() { },
		}
	)
}

export { identifier, unsafe, UnsafeString } from './yql.js'
