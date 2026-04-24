import type { Abortable } from 'node:events'
import { tracingChannel } from 'node:diagnostics_channel'

import { linkSignals } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition } from '@ydbjs/api/query'
import type { Driver } from '@ydbjs/core'
import { CommitError, YDBError } from '@ydbjs/error'
import { defaultRetryConfig, isRetryableError, retry } from '@ydbjs/retry'
import { loggers } from '@ydbjs/debug'

import { Query } from './query.js'
import { ctx } from './ctx.js'
import { UnsafeString, identifier, unsafe, yql } from './yql.js'
import { SessionPool, type SessionPoolOptions } from './session-pool.js'

const transactionCh = tracingChannel('tracing:@ydbjs:query.transaction')
const sessionAcquireCh = tracingChannel('tracing:@ydbjs:session.acquire')

let dbg = loggers.query

export type QueryOptions = {
	/**
	 * Session pool configuration
	 */
	poolOptions?: SessionPoolOptions
}

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

interface TransactionExecuteOptions extends Abortable {
	isolation?: 'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite'
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
export function query(driver: Driver, options?: QueryOptions): QueryClient {
	let sessionPool = new SessionPool(driver, options?.poolOptions)

	function yqlQuery<P extends any[] = unknown[], T extends any[] = unknown[]>(
		strings: string | TemplateStringsArray,
		...values: P
	): Query<T> {
		let { text, params } = yql(strings, ...values)
		dbg.log('creating query instance for text: %s', text)
		return ctx.run(ctx.getStore() ?? {}, () => new Query<T>(driver, text, params, sessionPool))
	}

	function txIml<T = unknown>(fn: TransactionContextCallback<T>): Promise<T>
	function txIml<T = unknown>(
		options: TransactionExecuteOptions,
		fn: TransactionContextCallback<T>
	): Promise<T>
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
	async function txIml<T = unknown>(
		optOrFn: TransactionExecuteOptions | TransactionContextCallback<T>,
		fn?: TransactionContextCallback<T>
	): Promise<T> {
		dbg.log('starting transaction')
		await driver.ready()
		// Snapshot the parent context once — we'll build a fresh attempt-scoped
		// store inside each retry so failed attempts don't leave stale
		// sessionId/transactionId in the shared store for the next one.
		let parentStore = ctx.getStore() || {}

		let caller = typeof optOrFn === 'function' ? optOrFn : fn
		let options = typeof optOrFn === 'function' ? ({} as TransactionExecuteOptions) : optOrFn
		options.isolation ??= 'serializableReadWrite'
		let idempotent = options.idempotent ?? false

		let sessionDiedLastAttempt = false

		return transactionCh.tracePromise(
			() =>
				retry(
					{
						...defaultRetryConfig,
						signal: options.signal,
						// Caller's flag flows through the retry layer unchanged and
						// lands back in the callback as the second arg — single source
						// of truth for whether the body is safe to replay.
						idempotent,
						retry: (error, idempotent) => {
							let sessionDied = sessionDiedLastAttempt
							sessionDiedLastAttempt = false
							// A session abort mid-tx means we don't know whether the
							// server applied any side effects — only re-open if the
							// caller opted into idempotent retries.
							return (
								isRetryableError(error, idempotent) || (sessionDied && idempotent)
							)
						},
						onRetry: (ctx) => {
							dbg.log(
								'retrying transaction, attempt %d, error: %O',
								ctx.attempt,
								ctx.error
							)
						},
					},
					async (retrySignal) => {
						dbg.log('acquiring session from pool for transaction')
						using sessionLease = await sessionAcquireCh.tracePromise(
							() => sessionPool.acquire(retrySignal),
							{}
						)
						dbg.log('session %s acquired for transaction', sessionLease.id)

						// linkSignals is disposed on scope exit — no listener buildup
						// on the long-lived session signal across tx retries.
						using linked = linkSignals(retrySignal, sessionLease.signal)
						let signal = linked.signal

						let attemptStore: typeof parentStore = {
							...parentStore,
							signal,
							nodeId: sessionLease.nodeId,
							sessionId: sessionLease.id,
						}

						let client = driver.createClient(
							QueryServiceDefinition,
							sessionLease.nodeId
						)

						let beginTransactionResult = await client.beginTransaction(
							{
								sessionId: attemptStore.sessionId!,
								txSettings: {
									txMode: { case: options.isolation!, value: {} },
								},
							},
							{ signal }
						)
						if (beginTransactionResult.status !== StatusIds_StatusCode.SUCCESS) {
							dbg.log(
								'failed to begin transaction, status: %d',
								beginTransactionResult.status
							)
							throw new YDBError(
								beginTransactionResult.status,
								beginTransactionResult.issues
							)
						}

						attemptStore.transactionId = beginTransactionResult.txMeta!.id

						let commitHooks: Array<(signal?: AbortSignal) => Promise<void> | void> = []
						let rollbackHooks: Array<
							(error: unknown, signal?: AbortSignal) => Promise<void> | void
						> = []
						let closeHooks: Array<
							(committed: boolean, signal?: AbortSignal) => Promise<void> | void
						> = []

						let committed = false
						try {
							let tx = Object.assign(yqlQuery, {
								nodeId: attemptStore.nodeId,
								sessionId: attemptStore.sessionId,
								transactionId: attemptStore.transactionId,
								onRollback: (fn: () => Promise<void> | void) => {
									rollbackHooks.push(fn)
								},
								onCommit: (fn: () => Promise<void> | void) => {
									commitHooks.push(fn)
								},
								onClose: (fn: () => Promise<void> | void) => {
									closeHooks.push(fn)
								},
							}) as TX

							dbg.log('executing transaction body')
							let result = await ctx.run(attemptStore, () => caller!(tx, signal))

							dbg.log('executing %d commit hooks', commitHooks.length)
							await Promise.all(
								commitHooks.map(async (hook, i) => {
									dbg.log('executing commit hook #%d', i + 1)
									await hook(signal)
									dbg.log('commit hook #%d completed', i + 1)
								})
							)

							dbg.log('committing transaction')
							let commitResult = await client.commitTransaction(
								{
									sessionId: attemptStore.sessionId!,
									txId: attemptStore.transactionId,
								},
								{ signal }
							)
							if (commitResult.status !== StatusIds_StatusCode.SUCCESS) {
								dbg.log(
									'failed to commit transaction, status: %d',
									commitResult.status
								)
								throw new CommitError(
									'Transaction commit failed.',
									new YDBError(commitResult.status, commitResult.issues)
								)
							}

							committed = true
							dbg.log('transaction committed successfully')
							return result
						} catch (error) {
							dbg.log('transaction error: %O', error)

							// Signal up to the retry callback that this attempt tore down
							// because the session died — lets it retry with a fresh one
							// if the caller opted into idempotent retries.
							if (sessionLease.signal.aborted) {
								sessionDiedLastAttempt = true
							}

							dbg.log('executing %d rollback hooks', rollbackHooks.length)
							await Promise.all(
								rollbackHooks.map(async (hook, i) => {
									dbg.log('executing rollback hook #%d', i + 1)
									await hook(error, signal)
									dbg.log('rollback hook #%d completed', i + 1)
								})
							)

							client
								.rollbackTransaction({
									sessionId: attemptStore.sessionId!,
									txId: attemptStore.transactionId,
								})
								.catch(() => {})

							if (!isRetryableError(error, idempotent)) {
								dbg.log('transaction not retryable, aborting')
								throw new Error('Transaction failed.', { cause: error })
							}

							throw error
						} finally {
							dbg.log('executing %d close hooks', closeHooks.length)
							await Promise.all(
								closeHooks.map(async (hook, i) => {
									dbg.log('executing close hook #%d', i + 1)
									await hook(committed, signal)
									dbg.log('close hook #%d completed', i + 1)
								})
							)
						}
					}
				),
			{ isolation: options.isolation ?? 'serializableReadWrite', idempotent }
		)
	}

	return Object.assign(yqlQuery, {
		do: doImpl,
		begin: txIml,
		transaction: txIml,
		identifier: identifier,
		unsafe: unsafe,
		async [Symbol.asyncDispose]() {
			await sessionPool.close()
		},
	})
}

export { type Query } from './query.ts'
export { identifier, unsafe, UnsafeString } from './yql.js'
export { type SessionPoolOptions } from './session-pool.js'
