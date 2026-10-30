import { tracingChannel } from 'node:diagnostics_channel'
import { AsyncLocalStorage } from 'node:async_hooks'

import { create } from '@bufbuild/protobuf'
import { abortable, linkSignals } from '@ydbjs/abortable'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import {
	ExecMode,
	QueryServiceDefinition,
	StatsMode,
	Syntax,
	TransactionControlSchema,
} from '@ydbjs/api/query'
import { type Column, type TypedValue } from '@ydbjs/api/value'
import type { Driver, DriverIdentity } from '@ydbjs/core'
import { CommitError, TransactionCompletionError, YDBError } from '@ydbjs/error'
import type { Metadata } from '@ydbjs/grpc'
import {
	type RetryConfig,
	type RetryContext,
	defaultRetryConfig,
	isRetryableError,
	retry,
} from '@ydbjs/retry'
import { fromYdb, toJs } from '@ydbjs/value'

import { type QueryParameters, encodeParameters } from './parameters.js'

import { type Session, SessionAbortedError } from './session.js'
import {
	SessionPool,
	SessionPoolClosedError,
	type SessionPoolOptions,
	sessionAcquireCh,
} from './session-pool.js'
import { type QueryPart, type QueryResult, QueryStream, type QuerySummary } from './stream.js'

export { type QueryStream, type QueryPart, type QueryResult, type QuerySummary } from './stream.js'

export type { QueryParameters } from './parameters.js'
export type Isolation =
	| 'implicit'
	| 'serializableReadWrite'
	| 'snapshotReadOnly'
	| 'snapshotReadWrite'
	| 'onlineReadOnly'
	| 'staleReadOnly'

export interface OperationOptions {
	signal?: AbortSignal | undefined
	timeout?: number | undefined
	idempotent?: boolean | undefined
	retry?: Pick<RetryConfig, 'budget' | 'strategy'> | undefined
	onRetry?: ((context: RetryContext) => void) | undefined
}

export interface StatementOptions extends Pick<OperationOptions, 'signal' | 'timeout'> {
	syntax?: Exclude<Syntax, Syntax.UNSPECIFIED> | undefined
	isolation?: Isolation | undefined
	allowInconsistentReads?: boolean | undefined
	statsMode?: StatsMode | undefined
	poolId?: string | undefined
	rowMode?: 'object' | 'array' | undefined
	raw?: boolean | undefined
	/** Target wire size of a result part; a single large row can exceed it. */
	responsePartLimitBytes?: number | undefined
	onMetadata?: ((metadata: Metadata) => void) | undefined
}

export interface TransactionOptions extends OperationOptions {
	isolation?: 'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite' | undefined
}

export interface QueryClientOptions {
	poolOptions?: SessionPoolOptions | undefined
}

export type TransactionStatementOptions = Omit<
	StatementOptions,
	'isolation' | 'allowInconsistentReads'
>

export interface QueryExecutor {
	readonly signal: AbortSignal
	readonly sessionId: string
	readonly nodeId: bigint
	execute<Row = Record<string, unknown>>(
		text: string,
		parameters?: QueryParameters,
		options?: StatementOptions
	): Promise<QueryResult<Row>>
	stream<Row = Record<string, unknown>>(
		text: string,
		parameters?: QueryParameters,
		options?: StatementOptions
	): QueryStream<Row>
}

export interface Transaction extends QueryExecutor {
	readonly transactionId: string
	execute<Row = Record<string, unknown>>(
		text: string,
		parameters?: QueryParameters,
		options?: TransactionStatementOptions
	): Promise<QueryResult<Row>>
	stream<Row = Record<string, unknown>>(
		text: string,
		parameters?: QueryParameters,
		options?: TransactionStatementOptions
	): QueryStream<Row>
	/** Runs before the commit RPC; used by transactional Topic producers and consumers. */
	beforeCommit(fn: (signal?: AbortSignal) => void | Promise<void>): void
	/** @deprecated Use beforeCommit. This hook runs before the commit RPC. */
	onCommit(fn: (signal?: AbortSignal) => void | Promise<void>): void
	onRollback(fn: (error: unknown, signal?: AbortSignal) => void | Promise<void>): void
	/** False means commit was not confirmed, including an unknown outcome. */
	onClose(fn: (committed: boolean, signal?: AbortSignal) => void | Promise<void>): void
}

type ExecuteContext = {
	driver: DriverIdentity
	text: string
	sessionId: string
	nodeId: bigint
	idempotent: boolean
	isolation: string
}
type TxContext = { driver: DriverIdentity; sessionId: string; nodeId: bigint; txId: string }
let executeCh = tracingChannel<ExecuteContext>('tracing:ydb:query.execute')
let beginCh = tracingChannel<{
	driver: DriverIdentity
	sessionId: string
	nodeId: bigint
	isolation: string
}>('tracing:ydb:query.begin')
let commitCh = tracingChannel<TxContext>('tracing:ydb:query.commit')
let rollbackCh = tracingChannel<TxContext>('tracing:ydb:query.rollback')
let transactionCh = tracingChannel<{
	driver: DriverIdentity
	isolation: string
	idempotent: boolean
}>('tracing:ydb:query.transaction')

class StreamClosedError extends Error {
	constructor(cause: unknown) {
		super('Query stream was closed before completion.', { cause })
	}
}

type Request = { text: string; parameters: Record<string, TypedValue>; options: StatementOptions }

function request(text: string, parameters: QueryParameters, options: StatementOptions): Request {
	validateOperation(options)
	if (typeof text !== 'string') throw new TypeError('Query text must be a string.')
	let encoded = encodeParameters(parameters)
	if (
		options.rowMode !== undefined &&
		options.rowMode !== 'object' &&
		options.rowMode !== 'array'
	)
		throw new TypeError('rowMode must be object or array.')
	if (
		options.isolation !== undefined &&
		![
			'implicit',
			'serializableReadWrite',
			'snapshotReadOnly',
			'snapshotReadWrite',
			'onlineReadOnly',
			'staleReadOnly',
		].includes(options.isolation)
	)
		throw new TypeError('Unsupported query isolation.')
	if (
		options.syntax !== undefined &&
		options.syntax !== Syntax.YQL_V1 &&
		options.syntax !== Syntax.PG
	)
		throw new TypeError('Unsupported query syntax.')
	if (
		options.responsePartLimitBytes !== undefined &&
		(!Number.isSafeInteger(options.responsePartLimitBytes) ||
			options.responsePartLimitBytes < 0 ||
			options.responsePartLimitBytes > 32 * 1024 * 1024)
	)
		throw new RangeError('responsePartLimitBytes must be an integer between 0 and 33554432.')
	return { text, parameters: encoded, options: { ...options } }
}

function validateOperation(options: OperationOptions): void {
	if (options === null || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('Operation options must be an object.')
	}
	options.signal?.throwIfAborted()
	if (options.idempotent !== undefined && typeof options.idempotent !== 'boolean')
		throw new TypeError('idempotent must be a boolean.')
	if (options.onRetry !== undefined && typeof options.onRetry !== 'function')
		throw new TypeError('onRetry must be a callback.')
	if (
		options.retry !== undefined &&
		(options.retry === null ||
			typeof options.retry !== 'object' ||
			Array.isArray(options.retry))
	)
		throw new TypeError('retry must be an object with a budget or strategy.')
	let budget = options.retry?.budget
	if (budget !== undefined && typeof budget !== 'number' && typeof budget !== 'function')
		throw new TypeError('Retry budget must be a number or callback.')
	if (
		typeof budget === 'number' &&
		budget !== Infinity &&
		(!Number.isSafeInteger(budget) || budget <= 0)
	)
		throw new RangeError('Retry budget must be a positive integer or Infinity.')
	let strategy = options.retry?.strategy
	if (strategy !== undefined && typeof strategy !== 'number' && typeof strategy !== 'function')
		throw new TypeError('Retry strategy must be a delay or callback.')
	if (typeof strategy === 'number' && (!Number.isFinite(strategy) || strategy < 0))
		throw new RangeError('Retry delay must be a non-negative finite number.')
}

function validateStatement(options: StatementOptions): void {
	for (let name of ['idempotent', 'retry', 'onRetry']) {
		if (name in options)
			throw new TypeError(
				`${name} belongs to retrySession() or retryTransaction(), not a statement.`
			)
	}
}

async function collect<Row>(stream: QueryStream<Row>): Promise<QueryResult<Row>> {
	let resultSets: QueryResult<Row>['resultSets'] = []
	for await (let part of stream) {
		let result = resultSets[part.resultSetIndex]
		if (!result) {
			result = { columns: part.columns, rows: part.rows, truncated: false }
			resultSets[part.resultSetIndex] = result
		} else {
			for (let row of part.rows) result.rows.push(row)
		}
		result.truncated ||= part.truncated
	}
	return { resultSets, ...stream.summary }
}

function timeoutSignal(options: OperationOptions): AbortSignal | undefined {
	return options.timeout === undefined ? undefined : AbortSignal.timeout(options.timeout)
}

/** Owns one session lease and all query streams started within one callback attempt. */
class Attempt implements Transaction {
	readonly signal: AbortSignal
	readonly cancellationSignal: AbortSignal
	readonly sessionId: string
	readonly nodeId: bigint
	readonly idempotent: boolean
	transactionId = ''
	committed = false
	#driver: Driver
	#session: Session
	#streams = new Set<QueryStream<unknown>>()
	#active = true
	#sealed = false
	#failure: unknown
	#failed = false
	#commitHooks: Array<(signal?: AbortSignal) => void | Promise<void>> | undefined = []
	rollbackHooks: Array<(error: unknown, signal?: AbortSignal) => void | Promise<void>> = []
	closeHooks: Array<(committed: boolean, signal?: AbortSignal) => void | Promise<void>> = []

	constructor(
		driver: Driver,
		session: Session,
		signal: AbortSignal,
		cancellationSignal: AbortSignal,
		idempotent: boolean
	) {
		this.#driver = driver
		this.#session = session
		this.signal = signal
		this.cancellationSignal = cancellationSignal
		this.idempotent = idempotent
		this.sessionId = session.id
		this.nodeId = session.nodeId
	}

	check(): void {
		if (!this.#active)
			throw new Error(
				'Query attempt has ended; execution is aborted and its executor cannot be reused.'
			)
		if (this.#sealed) throw new Error('Transaction has ended; its executor is closed.')
		if (this.#failed) throw this.#failure
		this.signal.throwIfAborted()
	}

	beforeCommit(fn: (signal?: AbortSignal) => void | Promise<void>): void {
		this.check()
		if (typeof fn !== 'function') throw new TypeError('beforeCommit() requires a callback.')
		if (!this.#commitHooks) throw new Error('Commit hooks have already started.')
		this.#commitHooks.push(fn)
	}

	takeCommitHooks(): Array<(signal?: AbortSignal) => void | Promise<void>> {
		if (!this.#commitHooks) throw new Error('Commit hooks have already started.')
		let hooks = this.#commitHooks
		this.#commitHooks = undefined
		return hooks
	}
	onCommit(fn: (signal?: AbortSignal) => void | Promise<void>): void {
		this.beforeCommit(fn)
	}
	onRollback(fn: (error: unknown, signal?: AbortSignal) => void | Promise<void>): void {
		this.check()
		if (typeof fn !== 'function') throw new TypeError('onRollback() requires a callback.')
		this.rollbackHooks.push(fn)
	}
	onClose(fn: (committed: boolean, signal?: AbortSignal) => void | Promise<void>): void {
		this.check()
		if (typeof fn !== 'function') throw new TypeError('onClose() requires a callback.')
		this.closeHooks.push(fn)
	}

	async execute<Row = Record<string, unknown>>(
		text: string,
		parameters: QueryParameters = {},
		options: StatementOptions = {}
	): Promise<QueryResult<Row>> {
		return collect(this.stream<Row>(text, parameters, options))
	}

	stream<Row = Record<string, unknown>>(
		text: string,
		parameters: QueryParameters = {},
		options: StatementOptions = {}
	): QueryStream<Row> {
		this.check()
		validateStatement(options)
		if (
			this.transactionId &&
			(options.isolation !== undefined || options.allowInconsistentReads !== undefined)
		)
			throw new TypeError(
				'Transaction isolation belongs to retryTransaction(), not a statement.'
			)
		return this.open<Row>(request(text, parameters, options))
	}

	open<Row>(prepared: Request): QueryStream<Row> {
		let timeout = timeoutSignal(prepared.options)
		let stream: QueryStream<Row> = new QueryStream<Row>(
			(signal, complete) => this.#read<Row>(prepared, signal, complete),
			[
				this.signal,
				...(prepared.options.signal ? [prepared.options.signal] : []),
				...(timeout ? [timeout] : []),
			],
			() => this.#streams.delete(stream as QueryStream<unknown>)
		)
		this.#streams.add(stream as QueryStream<unknown>)
		return stream
	}

	async *#read<Row>(
		prepared: Request,
		signal: AbortSignal,
		complete: (summary: QuerySummary) => void
	): AsyncGenerator<QueryPart<Row>> {
		this.check()
		let finished = false
		try {
			yield* readQuery<Row>(
				this.#driver,
				this.#session,
				this.transactionId,
				prepared,
				signal,
				complete,
				this.idempotent
			)
			finished = true
		} catch (error) {
			this.#failed = true
			this.#failure =
				signal.aborted && error === signal.reason && error !== this.signal.reason
					? new StreamClosedError(error)
					: error
			throw error
		} finally {
			if (!finished && !this.#failed) {
				this.#failed = true
				this.#failure =
					signal.aborted && signal.reason === this.signal.reason
						? signal.reason
						: new StreamClosedError(signal.reason)
			}
		}
	}

	failure(error: unknown): unknown {
		if (error instanceof TransactionCompletionError) return error
		if (this.cancellationSignal.aborted) return this.cancellationSignal.reason
		if (this.#failure instanceof StreamClosedError && error === this.#failure.cause)
			return this.#failure
		return this.#failed && this.signal.aborted && error === this.signal.reason
			? this.#failure
			: error
	}

	assertConsumed(): void {
		if (!this.#active) throw new Error('Query attempt has ended.')
		if (this.#failed) throw this.#failure
		if (this.#streams.size)
			throw new Error('Consume query streams inside the callback before it returns.')
	}

	async finish(): Promise<void> {
		this.#active = false
		await Promise.allSettled(
			[...this.#streams].map((stream) =>
				stream.throw(
					new Error('Query attempt has ended; its streams cannot escape the callback.')
				)
			)
		)
		this.#streams.clear()
		this.#commitHooks = undefined
		this.rollbackHooks.length = 0
		this.closeHooks.length = 0
	}

	invalidate(): void {
		this.#session.invalidate()
	}
	seal(): void {
		this.#sealed = true
	}
}

function executorScope(attempt: Attempt): QueryExecutor {
	return Object.freeze({
		signal: attempt.signal,
		sessionId: attempt.sessionId,
		nodeId: attempt.nodeId,
		execute: attempt.execute.bind(attempt),
		stream: attempt.stream.bind(attempt),
	})
}

function transactionScope(attempt: Attempt): Transaction {
	let beforeCommit = attempt.beforeCommit.bind(attempt)
	return Object.freeze({
		...executorScope(attempt),
		transactionId: attempt.transactionId,
		beforeCommit,
		onCommit: beforeCommit,
		onRollback: attempt.onRollback.bind(attempt),
		onClose: attempt.onClose.bind(attempt),
	})
}

export class QueryClient implements AsyncDisposable, Disposable {
	#driver: Driver
	#pool: SessionPool
	#destroyed = new AbortController()

	constructor(driver: Driver, options: QueryClientOptions = {}) {
		this.#driver = driver
		this.#pool = new SessionPool(driver, options.poolOptions)
	}

	get signal(): AbortSignal {
		return this.#destroyed.signal
	}
	get closed(): boolean {
		return this.#pool.closed
	}
	close(): Promise<void> {
		return this.#pool.close()
	}
	destroy(): void {
		this.#destroyed.abort(new SessionPoolClosedError())
		this.#pool.destroy()
	}
	[Symbol.dispose](): void {
		this.destroy()
	}
	async [Symbol.asyncDispose](): Promise<void> {
		await this.close()
	}

	retrySession<T>(
		callback: (executor: QueryExecutor, signal: AbortSignal) => Promise<T>
	): Promise<T>
	retrySession<T>(
		options: OperationOptions,
		callback: (executor: QueryExecutor, signal: AbortSignal) => Promise<T>
	): Promise<T>
	async retrySession<T>(
		optionsOrCallback:
			| OperationOptions
			| ((executor: QueryExecutor, signal: AbortSignal) => Promise<T>),
		callback?: (executor: QueryExecutor, signal: AbortSignal) => Promise<T>
	): Promise<T> {
		if (typeof optionsOrCallback === 'function' && callback !== undefined)
			throw new TypeError('Use retrySession(options, callback).')
		let options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
		let caller = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
		if (typeof caller !== 'function')
			throw new TypeError('retrySession() requires an async callback.')
		return this.#run(options, (attempt) =>
			abortable(
				attempt.cancellationSignal,
				Promise.resolve(caller(executorScope(attempt), attempt.signal))
			)
		)
	}

	retryTransaction<T>(
		callback: (transaction: Transaction, signal: AbortSignal) => Promise<T>
	): Promise<T>
	retryTransaction<T>(
		options: TransactionOptions,
		callback: (transaction: Transaction, signal: AbortSignal) => Promise<T>
	): Promise<T>
	async retryTransaction<T>(
		optionsOrCallback:
			| TransactionOptions
			| ((transaction: Transaction, signal: AbortSignal) => Promise<T>),
		callback?: (transaction: Transaction, signal: AbortSignal) => Promise<T>
	): Promise<T> {
		if (typeof optionsOrCallback === 'function' && callback !== undefined)
			throw new TypeError('Use retryTransaction(options, callback).')
		let options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
		let caller = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
		if (typeof caller !== 'function')
			throw new TypeError('retryTransaction() requires an async callback.')
		validateOperation(options)
		let isolation = options.isolation ?? 'serializableReadWrite'
		if (!['serializableReadWrite', 'snapshotReadOnly', 'snapshotReadWrite'].includes(isolation))
			throw new TypeError('Unsupported transaction isolation.')
		return transactionCh.tracePromise(
			() =>
				this.#run(options, async (attempt) => {
					let rpc = this.#driver.createClient(QueryServiceDefinition, attempt.nodeId)
					let signal = attempt.signal
					let begin = await beginCh
						.tracePromise(
							() =>
								rpc.beginTransaction(
									{
										sessionId: attempt.sessionId,
										txSettings: { txMode: { case: isolation, value: {} } },
									},
									{ signal }
								),
							{
								driver: this.#driver.identity,
								sessionId: attempt.sessionId,
								nodeId: attempt.nodeId,
								isolation,
							}
						)
						.catch((error) => {
							attempt.invalidate()
							throw error
						})
					if (begin.status !== Status.SUCCESS) {
						if (fatalSessionStatus(begin.status)) attempt.invalidate()
						throw new YDBError(begin.status, begin.issues)
					}
					if (!begin.txMeta?.id) {
						attempt.invalidate()
						throw new Error('BeginTransaction returned no transaction ID.')
					}
					attempt.transactionId = begin.txMeta.id
					let context = {
						driver: this.#driver.identity,
						sessionId: attempt.sessionId,
						nodeId: attempt.nodeId,
						txId: attempt.transactionId,
					}
					let committed = false
					let failed = false
					let failure: unknown
					let result: T | undefined
					try {
						signal.throwIfAborted()
						result = await abortable(
							attempt.cancellationSignal,
							Promise.resolve(caller(transactionScope(attempt), signal))
						)
						attempt.assertConsumed()
						await Promise.all(
							// Capture synchronous throws so every started hook remains observed.
							attempt.takeCommitHooks().map(async (hook) => {
								await abortable(
									attempt.cancellationSignal,
									Promise.resolve(hook(signal))
								)
							})
						)
						attempt.assertConsumed()
						attempt.seal()
						let response = await commitCh
							.tracePromise(
								() =>
									rpc.commitTransaction(
										{
											sessionId: attempt.sessionId,
											txId: attempt.transactionId,
										},
										{ signal }
									),
								context
							)
							.catch((error) => {
								attempt.invalidate()
								throw error
							})
						if (response.status !== Status.SUCCESS) {
							if (fatalSessionStatus(response.status)) attempt.invalidate()
							throw new CommitError(
								'Transaction commit failed.',
								new YDBError(response.status, response.issues)
							)
						}
						committed = true
						attempt.committed = true
					} catch (cause) {
						attempt.seal()
						let error = attempt.failure(cause)
						failed = true
						failure = error
						if (!this.signal.aborted) {
							let cleanupErrors: unknown[] = []
							try {
								await Promise.all(
									attempt.rollbackHooks.map(async (hook) => {
										await abortable(
											attempt.cancellationSignal,
											Promise.resolve(hook(error, signal))
										)
									})
								)
							} catch (cleanupError) {
								cleanupErrors.push(cleanupError)
							}
							using cleanup = linkSignals(this.signal, AbortSignal.timeout(5000))
							await rollbackCh
								.tracePromise(
									() =>
										rpc.rollbackTransaction(
											{
												sessionId: attempt.sessionId,
												txId: attempt.transactionId,
											},
											{ signal: cleanup.signal }
										),
									context
								)
								.then(
									(response) => {
										if (response.status !== Status.SUCCESS) attempt.invalidate()
										return undefined
									},
									() => attempt.invalidate()
								)
							if (cleanupErrors.length)
								failure = new AggregateError(
									[error, ...cleanupErrors],
									'Transaction and rollback hooks failed.'
								)
						}
					} finally {
						if (!this.signal.aborted) {
							try {
								await Promise.all(
									attempt.closeHooks.map(async (hook) => {
										await abortable(
											attempt.cancellationSignal,
											Promise.resolve(hook(committed, signal))
										)
									})
								)
							} catch (error) {
								if (failed)
									failure = new AggregateError(
										[failure, error],
										'Transaction and close hooks failed.'
									)
								else {
									failed = true
									failure = error
								}
							}
						}
					}
					if (failed) {
						if (committed) throw new TransactionCompletionError(failure)
						throw failure
					}
					return result as T
				}),
			{ driver: this.#driver.identity, isolation, idempotent: options.idempotent ?? false }
		)
	}

	#acquire(signal: AbortSignal) {
		return sessionAcquireCh.tracePromise(() => this.#pool.acquire(signal), {
			driver: this.#driver.identity,
		})
	}

	async #run<T>(
		options: OperationOptions,
		callback: (attempt: Attempt) => Promise<T>
	): Promise<T> {
		validateOperation(options)
		options = { ...options, ...(options.retry ? { retry: { ...options.retry } } : {}) }
		using lifetime = linkSignals(this.signal, options.signal, timeoutSignal(options))
		this.#pool.beginOperation()
		let currentAttempt: Attempt | undefined
		try {
			await this.#driver.ready(lifetime.signal)
			return await retry(
				{
					...defaultRetryConfig,
					...options.retry,
					signal: lifetime.signal,
					idempotent: options.idempotent ?? false,
					...(options.onRetry ? { onRetry: options.onRetry } : {}),
					retry: (error, idempotent) =>
						isRetryableError(error, idempotent) ||
						(error instanceof SessionAbortedError && idempotent),
				},
				async (signal) => {
					this.#pool.beginOperation(true)
					try {
						using lease = await this.#acquire(signal)
						using linked = linkSignals(signal, lease.signal)
						let attempt = new Attempt(
							this.#driver,
							lease.session,
							linked.signal,
							signal,
							options.idempotent ?? false
						)
						currentAttempt = attempt
						try {
							attempt.check()
							let result = await abortable(
								this.signal,
								Promise.resolve(callback(attempt))
							)
							if (!attempt.committed) attempt.assertConsumed()
							return result
						} catch (error) {
							throw attempt.failure(error)
						} finally {
							await attempt.finish()
						}
					} finally {
						this.#pool.endOperation(true)
					}
				}
			)
		} catch (error) {
			if (error instanceof TransactionCompletionError) throw error
			if (currentAttempt?.committed) throw new TransactionCompletionError(error)
			if (
				lifetime.signal.aborted &&
				(isRetryableError(error, true) || error instanceof SessionAbortedError)
			) {
				// A caller's cancellation reason is not a database failure an enclosing scope can replay.
				let cancelled = new Error('Query operation cancelled.', { cause: error })
				cancelled.name = 'AbortError'
				throw cancelled
			}
			throw error
		} finally {
			this.#pool.endOperation()
		}
	}
}

function fatalSessionStatus(status: Status): boolean {
	return (
		status === Status.BAD_SESSION ||
		status === Status.SESSION_EXPIRED ||
		status === Status.INTERNAL_ERROR
	)
}

function tracedParts<T>(
	source: AsyncIterable<T>,
	enter: ReturnType<typeof AsyncLocalStorage.snapshot>
): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]() {
			let iterator = source[Symbol.asyncIterator]()
			return {
				next: () => enter(() => iterator.next()),
				return: () =>
					enter(
						() =>
							iterator.return?.() ?? Promise.resolve({ done: true, value: undefined })
					),
			}
		},
	}
}

async function* readQuery<Row>(
	driver: Driver,
	session: Session,
	transactionId: string,
	prepared: Request,
	signal: AbortSignal,
	complete: (summary: QuerySummary) => void,
	idempotent: boolean
): AsyncGenerator<QueryPart<Row>> {
	// oxlint-disable-next-line no-underscore-dangle
	using _claim = session.claim()
	let { text, parameters, options } = prepared
	let rpc = driver.createClient(QueryServiceDefinition, session.nodeId)
	let txControl = transactionId
		? create(TransactionControlSchema, { txSelector: { case: 'txId', value: transactionId } })
		: options.isolation && options.isolation !== 'implicit'
			? create(TransactionControlSchema, {
					commitTx: true,
					txSelector: {
						case: 'beginTx',
						value: {
							txMode:
								options.isolation === 'onlineReadOnly'
									? {
											case: options.isolation,
											value: {
												allowInconsistentReads:
													options.allowInconsistentReads ?? false,
											},
										}
									: { case: options.isolation, value: {} },
						},
					},
				})
			: undefined
	let summary: QuerySummary = {}
	let columns = new Map<number, readonly Column[]>()
	let finished = false
	let serverError: YDBError | undefined
	let context: ExecuteContext = {
		driver: driver.identity,
		text,
		sessionId: session.id,
		nodeId: session.nodeId,
		idempotent,
		isolation: options.isolation ?? 'implicit',
	}
	let done: PromiseWithResolvers<void> | undefined
	let traced: Promise<void> | undefined
	let enter: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined
	// Some runtimes expose subscriber flags only on the individual channels.
	if (
		executeCh.hasSubscribers ||
		executeCh.start.hasSubscribers ||
		executeCh.end.hasSubscribers ||
		executeCh.asyncStart.hasSubscribers ||
		executeCh.asyncEnd.hasSubscribers ||
		executeCh.error.hasSubscribers
	) {
		done = Promise.withResolvers<void>()
		let promise = done.promise
		traced = executeCh.tracePromise(() => {
			enter = AsyncLocalStorage.snapshot()
			return promise
		}, context)
		void traced.catch(() => {})
	}
	try {
		let stream = rpc.executeQuery(
			{
				sessionId: session.id,
				query: {
					case: 'queryContent',
					value: { syntax: options.syntax ?? Syntax.YQL_V1, text },
				},
				parameters,
				execMode: ExecMode.EXECUTE,
				statsMode: options.statsMode ?? StatsMode.UNSPECIFIED,
				poolId: options.poolId ?? '',
				responsePartLimitBytes: BigInt(options.responsePartLimitBytes ?? 1024 * 1024),
				...(txControl ? { txControl } : {}),
			},
			{
				signal,
				onTrailer: (metadata) => {
					summary.metadata = metadata
					if (!signal.aborted && options.onMetadata) {
						try {
							options.onMetadata(metadata)
						} catch (cause) {
							throw new Error('Query metadata observer failed.', { cause })
						}
					}
				},
			}
		)
		for await (let part of enter ? tracedParts(stream, enter) : stream) {
			signal.throwIfAborted()
			if (part.status !== Status.SUCCESS) {
				serverError = new YDBError(part.status, part.issues)
				continue
			}
			if (serverError) continue
			if (part.execStats) summary.stats = part.execStats
			if (!part.resultSet) continue
			let index = Number(part.resultSetIndex)
			if (!Number.isSafeInteger(index) || index < 0)
				throw new Error('Invalid result set index.')
			if (part.resultSet.columns.length) columns.set(index, part.resultSet.columns)
			let schema = columns.get(index) ?? part.resultSet.columns
			let rows: Row[] = []
			for (let values of part.resultSet.rows) {
				if (values.items.length !== schema.length)
					throw new Error('Result row does not match its columns.')
				let row: any = options.rowMode === 'array' ? [] : {}
				for (let i = 0; i < schema.length; i++) {
					let column = schema[i]!
					let wire = values.items[i]!
					let value = options.raw ? wire : toJs(fromYdb(wire, column.type!))
					if (options.rowMode === 'array') row.push(value)
					else
						Object.defineProperty(row, column.name, {
							value,
							writable: true,
							enumerable: true,
							configurable: true,
						})
				}
				rows.push(row)
			}
			yield {
				resultSetIndex: index,
				columns: schema,
				rows,
				truncated: part.resultSet.truncated,
			}
		}
		finished = true
		if (serverError) {
			if (fatalSessionStatus(serverError.code)) session.invalidate()
			throw serverError
		}
		complete(summary)
		done?.resolve()
	} catch (error) {
		done?.reject(error)
		throw error
	} finally {
		if (!finished) {
			// Cancelling ExecuteQuery does not prove the server is idle. Closing Attach retires its session.
			session.invalidate()
			done?.reject(
				signal.aborted ? signal.reason : new Error('Query stream closed before completion.')
			)
		}
		await traced?.catch(() => {})
	}
}
