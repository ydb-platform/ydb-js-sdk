import { EventEmitter } from 'node:events'

import { linkSignals } from '@ydbjs/abortable'
import { type QueryStats, StatsMode, Syntax } from '@ydbjs/api/query'
import type { Metadata } from '@ydbjs/grpc'
import type { RetryContext } from '@ydbjs/retry'
import { type JSValue, type Value, fromJs } from '@ydbjs/value'

import {
	type QueryClient,
	type QueryExecutor,
	type StatementOptions,
	executePrepared,
	prepareQuery,
} from './client.js'
import { ctx } from './ctx.js'
import { cancellationError } from './cancellation.js'
import { SessionPoolClosedError } from './session-pool.js'

import type { QueryResult, ResultTypes } from './result.js'

type QueryRows<T extends ResultTypes> = {
	[Index in keyof T]: T[Index][]
}

type ValueRows<T extends ResultTypes> = Extract<{ [Index in keyof T]: unknown[] }, ResultTypes>

export type QueryEventMap<T extends ResultTypes = ResultTypes> = {
	done: [QueryRows<T>]
	retry: [RetryContext]
	error: [unknown]
	stats: [QueryStats]
	cancel: []
	metadata: [Metadata]
}

export class Query<T extends ResultTypes = ResultTypes>
	extends EventEmitter<QueryEventMap<T>>
	implements PromiseLike<QueryRows<T>>, AsyncDisposable
{
	#client: QueryClient
	#executor: QueryExecutor | undefined
	#promise: Promise<QueryRows<T>> | null = null

	#text: string
	#parameters: Record<string, Value>
	#idempotent: boolean = false

	#active: boolean = false
	#disposed: boolean = false
	#cancelled: boolean = false
	#controller: AbortController | undefined

	#signal: AbortSignal | undefined
	#timeout: number | undefined

	#syntax: Exclude<Syntax, Syntax.UNSPECIFIED> = Syntax.YQL_V1
	#poolId: string | undefined

	#stats: QueryStats | undefined
	#statsMode: StatsMode = StatsMode.UNSPECIFIED

	#isolation:
		| 'implicit'
		| 'serializableReadWrite'
		| 'snapshotReadOnly'
		| 'snapshotReadWrite'
		| 'onlineReadOnly'
		| 'staleReadOnly' = 'implicit'
	#isolationSettings: { allowInconsistentReads: boolean } | {} = {}

	#raw: boolean = false
	#values: boolean = false

	constructor(
		client: QueryClient,
		text: string,
		params: Record<string, Value>,
		executor?: QueryExecutor
	) {
		super()

		this.#text = text
		this.#client = client
		this.#executor = executor
		this.#parameters = {}

		for (let [key, value] of Object.entries(params)) {
			this.#parameters[key.startsWith('$') ? key : '$' + key] = value
		}
	}

	static get [Symbol.species]() {
		return Promise
	}

	async #execute(): Promise<QueryRows<T>> {
		if (this.#disposed) {
			throw new Error('Query has been disposed.')
		}

		if (this.#promise) {
			return this.#promise
		}

		this.#client.signal.throwIfAborted()

		let store = ctx.getStore()
		let executor =
			this.#executor ?? (store?.client === this.#client ? store.executor : undefined)

		if (!executor && this.#client.closed) {
			throw new SessionPoolClosedError()
		}

		let transactional =
			executor && 'transactionId' in executor && Boolean(executor.transactionId)
		let timeout = this.#timeout === undefined ? undefined : AbortSignal.timeout(this.#timeout)
		let controller = (this.#controller ??= new AbortController())
		let linked = linkSignals(controller.signal, this.#client.signal, this.#signal, timeout)
		let onDestroy = () => {
			return this.destroy()
		}

		this.#client.signal.addEventListener('abort', onDestroy, { once: true })
		this.#active = true

		try {
			linked.signal.throwIfAborted()

			let text = this.text
			let options: StatementOptions = {
				signal: linked.signal,
				syntax: this.#syntax,
				...(!transactional
					? {
							isolation: this.#isolation,
							allowInconsistentReads:
								'allowInconsistentReads' in this.#isolationSettings
									? this.#isolationSettings.allowInconsistentReads
									: undefined,
						}
					: {}),
				statsMode: this.#statsMode,
				poolId: this.#poolId,
				rowMode: this.#values ? 'array' : 'object',
				raw: this.#raw,
				onMetadata: (metadata) => {
					if (!this.#disposed && !linked.signal.aborted) {
						this.emit('metadata', metadata)
					}
				},
			}

			let operation: Promise<QueryResult<T>>

			if (executor) {
				operation = executor.execute<T>(text, this.#parameters, options)
			} else {
				// This operation owns its encoded text, options and values across every automatic retry.
				let prepared = prepareQuery(text, this.#parameters, options)

				operation = this.#client.retrySession(
					{
						signal: linked.signal,
						idempotent: this.#idempotent,
						onRetry: (context) => {
							return this.emit('retry', context)
						},
					},
					(session) => {
						return executePrepared<T>(session, prepared)
					}
				)
			}

			this.#promise = operation
				.then((result) => {
					linked.signal.throwIfAborted()

					this.#stats = result.stats

					if (this.#stats) {
						this.emit('stats', this.#stats)
					}

					linked.signal.throwIfAborted()

					let rows = result.resultSets.map((set) => {
						return set.rows
					}) as QueryRows<T>

					this.emit('done', rows)
					linked.signal.throwIfAborted()

					return rows
				})
				.catch((cause) => {
					let error = linked.signal.aborted ? cancellationError(cause) : cause

					if (
						!this.#disposed &&
						!this.#client.signal.aborted &&
						this.listenerCount('error')
					) {
						this.emit('error', error)
					}

					throw error
				})
				.finally(() => {
					this.#active = false
					controller.abort('Query completed.')
					linked[Symbol.dispose]()
					this.#client.signal.removeEventListener('abort', onDestroy)
				})

			return this.#promise
		} catch (cause) {
			let error = linked.signal.aborted ? cancellationError(cause) : cause

			this.#active = false
			linked[Symbol.dispose]()
			this.#client.signal.removeEventListener('abort', onDestroy)

			throw error
		}
	}

	/** Returns the result of the query */
	then<TResult1 = QueryRows<T>, TResult2 = never>(
		onfulfilled?: ((value: QueryRows<T>) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		return this.#execute().then(onfulfilled, onrejected)
	}

	/** Indicates if the query is currently executing */
	get active(): boolean {
		return this.#active
	}

	/** Indicates if the query has been cancelled */
	get cancelled(): boolean {
		return this.#cancelled
	}

	get text(): string {
		return this.#text
	}

	get parameters(): Record<string, Value> {
		return this.#parameters
	}

	syntax(syntax: Exclude<Syntax, Syntax.UNSPECIFIED>): Query<T> {
		this.#syntax = syntax

		return this
	}

	pool(poolId: string): Query<T> {
		this.#poolId = poolId

		return this
	}

	/** Bind a JS value or an explicitly typed YDB Value. Pass undefined to remove the binding. */
	parameter(name: string, parameter: JSValue | undefined): Query<T> {
		if (!name.startsWith('$')) {
			name = '$' + name
		}

		if (parameter === undefined) {
			delete this.#parameters[name]

			return this
		}

		this.#parameters[name] = fromJs(parameter)

		return this
	}

	/** Alias for {@link parameter}. */
	param(name: string, parameter: JSValue | undefined): Query<T> {
		return this.parameter(name, parameter)
	}

	/**
	 * Sets the idempotent flag for the query.
	 *
	 * ONLY FOR SINGLE EXECUTE CALLS.
	 * DO NOTHING IN TRANSACTION CONTEXT (sql.begin or sql.transaction).
	 *
	 * Idempotent queries may be retried without side effects.
	 */
	idempotent(idempotent: boolean = true): Query<T> {
		this.#idempotent = idempotent

		return this
	}

	/**
	 * Sets the transaction isolation level for a single execute call.
	 *
	 * ONLY FOR SINGLE EXECUTE CALLS.
	 * DO NOTHING IN TRANSACTION CONTEXT (sql.begin or sql.transaction).
	 *
	 * A transaction is always used. If `mode` is 'implicit', the database decides the isolation level.
	 * If a specific isolation `mode` is provided, the query will be executed within a single transaction (with inline begin and commit)
	 * using the specified isolation level.
	 *
	 * @param mode Transaction isolation level:
	 *  - 'serializableReadWrite' — serializable read/write
	 *  - 'snapshotReadOnly' — snapshot read-only
	 *  - 'snapshotReadWrite' — snapshot read/write
	 *  - 'onlineReadOnly' — online read-only
	 *  - 'staleReadOnly' — stale read-only
	 *  - 'implicit' — isolation is not set, server decides
	 *  - 'implicit' is the default value
	 * @param settings Additional options, e.g., allowInconsistentReads — allow inconsistent reads only with 'onlineReadOnly'
	 * @returns The current instance for chaining
	 */
	isolation(
		mode:
			| 'implicit'
			| 'serializableReadWrite'
			| 'snapshotReadOnly'
			| 'snapshotReadWrite'
			| 'onlineReadOnly'
			| 'staleReadOnly',
		settings: { allowInconsistentReads: boolean } | {} | undefined = {}
	) {
		this.#isolation = mode
		this.#isolationSettings = settings

		return this
	}

	/** Returns the query execution statistics */
	// TODO: Return user-friendly stats report
	stats(): QueryStats | undefined {
		return this.#stats
	}

	/** Returns a query with statistics enabled */
	withStats(mode: Exclude<StatsMode, StatsMode.UNSPECIFIED>): Query<T> {
		this.#statsMode = mode

		return this as Query<T>
	}

	/** Sets the query timeout */
	timeout(timeout: number): Query<T> {
		this.#timeout = timeout

		return this
	}

	/** Cancels the executing query */
	cancel(): Query<T> {
		let controller = (this.#controller ??= new AbortController())
		controller.abort('Query cancelled by user.')
		this.#cancelled = true
		this.emit('cancel')

		return this
	}

	signal(signal: AbortSignal): Query<T> {
		this.#signal = signal

		return this
	}

	/** Executes the query */
	execute(): Query<T> {
		void this.#execute().catch(() => {})

		return this
	}

	/** Returns only the values from the query result */
	values(): Query<ValueRows<T>> {
		this.#values = true

		return this as unknown as Query<ValueRows<T>>
	}

	/** Returns raw values */
	raw(): Query<T> {
		this.#raw = true

		return this
	}

	/**
	 * Disposes the query and releases all resources.
	 * Cancel pending work and discard the query's retained results and parameters.
	 */
	async dispose(): Promise<void> {
		this.destroy()
	}

	destroy(): void {
		if (this.#disposed) {
			return
		}

		this.#disposed = true
		this.#active = false
		this.removeAllListeners()
		this.#controller?.abort('Query disposed.')
		this.#promise = null
		this.#parameters = {}
		this.#stats = undefined
		this.#signal = undefined
		this.#text = ''
	}

	[Symbol.dispose](): void {
		this.destroy()
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.dispose()
	}
}
