import type { Abortable } from 'node:events'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition, type SessionState } from '@ydbjs/api/query'
import type { Driver } from '@ydbjs/core'
import { CommitError, YDBError } from '@ydbjs/error'
import { defaultRetryConfig, isRetryableError, retry } from '@ydbjs/retry'
import { type Value, fromJs } from '@ydbjs/value'

import { Query } from './query.js'
import { ctx } from './ctx.js'

type SQL = <T extends any[] = unknown[], P extends any[] = unknown[]>(
	strings: string | TemplateStringsArray,
	...values: P
) => Query<T>

interface SessionContextCallback<T> {
	(signal: AbortSignal): Promise<T>
}

interface TransactionExecuteOptions extends Abortable {
	isolation?: 'serializableReadWrite' | 'snapshotReadOnly'
	idempotent?: boolean
}

interface TransactionContextCallback<T> {
	(tx: SQL, signal: AbortSignal): Promise<T>
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
	function yql<T extends any[] = unknown[], P extends any[] = unknown[]>(
		strings: string | TemplateStringsArray,
		...values: P
	): Query<T> {
		let text = ''
		let params: Record<string, Value> = Object.assign({}, null)

		if (Array.isArray(values)) {
			values.forEach((value, i) => {
				let isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
				let ydbValue = isObject && 'type' in value && 'kind' in value['type'] ? value : fromJs(value)

				params[`$p${i}`] = ydbValue
			})
		}

		if (typeof strings === 'string') {
			text += strings
		}

		if (Array.isArray(strings)) {
			text += strings.reduce((prev, curr, i) => prev + curr + (values[i] ? `$p${i}` : ''), '')
		}

		return ctx.run(ctx.getStore() ?? {}, () => new Query(driver, text, params))
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
		await driver.ready()
		let store = ctx.getStore() || {}
		let client = driver.createClient(QueryServiceDefinition)

		let caller = (typeof optOrFn === "function" ? optOrFn : fn)
		let options = typeof optOrFn === "function" ? ({} as TransactionExecuteOptions) : optOrFn
		options.isolation ??= "serializableReadWrite"
		options.idempotent = options.idempotent ?? false;

		return retry({ ...defaultRetryConfig, signal: options.signal, idempotent: true }, async (signal) => {
			let sessionResponse = await client.createSession({}, { signal })
			if (sessionResponse.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(sessionResponse.status, sessionResponse.issues)
			}

			store.signal = signal
			store.nodeId = sessionResponse.nodeId
			store.sessionId = sessionResponse.sessionId

			client = driver.createClient(QueryServiceDefinition, sessionResponse.nodeId)

			let attachSession = Promise.withResolvers<SessionState>()
				; (async (stream: AsyncIterable<SessionState>) => {
					try {
						for await (let state of stream) {
							signal.throwIfAborted()
							attachSession.resolve(state)
						}
					} catch (err) {
						attachSession.reject(err)
					}
				})(client.attachSession({ sessionId: store.sessionId }, { signal }))

			let attachSessionResult = await attachSession.promise
			if (attachSessionResult.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(attachSessionResult.status, attachSessionResult.issues)
			}

			let beginTransactionResult = await client.beginTransaction({
				sessionId: store.sessionId,
				txSettings: { txMode: { case: options.isolation!, value: {} } },
			}, { signal })
			if (beginTransactionResult.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(beginTransactionResult.status, beginTransactionResult.issues)
			}

			store.transactionId = beginTransactionResult.txMeta?.id

			try {
				let result = await ctx.run(store, () => caller!(yql, signal))

				let commitResult = await client.commitTransaction({ sessionId: store.sessionId, txId: store.transactionId }, { signal })
				if (commitResult.status !== StatusIds_StatusCode.SUCCESS) {
					throw new CommitError("Transaction commit failed.", new YDBError(commitResult.status, commitResult.issues))
				}

				return result
			} catch (err) {
				void client.rollbackTransaction({ sessionId: store.sessionId, txId: store.transactionId })

				if (!isRetryableError(err, options.idempotent)) {
					throw new Error("Transaction failed.", { cause: err })
				}

				throw err
			} finally {
				void client.deleteSession({ sessionId: sessionResponse.sessionId })
			}
		})
	}

	return Object.assign(yql,
		{
			do: doImpl,
			begin: txIml,
			transaction: txIml,
			async [Symbol.asyncDispose]() { },
		}
	)
}
