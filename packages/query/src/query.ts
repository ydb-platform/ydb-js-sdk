import { EventEmitter } from 'node:events'

import { linkSignals } from '@ydbjs/abortable'
import { type QueryStats, StatsMode, Syntax } from '@ydbjs/api/query'
import type { Metadata } from '@ydbjs/grpc'
import type { RetryContext } from '@ydbjs/retry'
import type { Value } from '@ydbjs/value'
import { typeToString } from '@ydbjs/value/print'

import type { QueryClient, QueryExecutor, StatementOptions } from './client.js'
import { ctx } from './ctx.js'
import { bindParameters } from './parameters.js'
import { SessionPoolClosedError } from './session-pool.js'

// Utility type to convert a tuple of types to a tuple of arrays of those types
type ArrayifyTuple<T extends any[]> = {
	[K in keyof T]: T[K][]
}

export type QueryEventMap = {
	done: [ArrayifyTuple<any>]
	retry: [RetryContext]
	error: [unknown]
	stats: [QueryStats]
	cancel: []
	metadata: [Metadata]
}

export class Query<T extends any[] = unknown[]>
	extends EventEmitter<QueryEventMap>
	implements PromiseLike<ArrayifyTuple<T>>, AsyncDisposable
{
	#client: QueryClient
	#executor: QueryExecutor | undefined
	#promise: Promise<ArrayifyTuple<T>> | null = null

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

	async #execute(): Promise<ArrayifyTuple<T>> {
		if (this.#disposed) throw new Error('Query has been disposed.')
		if (this.#promise) return this.#promise
		this.#client.signal.throwIfAborted()
		let store = ctx.getStore()
		let executor =
			this.#executor ?? (store?.client === this.#client ? store.executor : undefined)
		if (!executor && this.#client.closed) throw new SessionPoolClosedError()
		let transactional =
			executor && 'transactionId' in executor && Boolean(executor.transactionId)
		let timeout = this.#timeout === undefined ? undefined : AbortSignal.timeout(this.#timeout)
		let controller = (this.#controller ??= new AbortController())
		let linked = linkSignals(controller.signal, this.#client.signal, this.#signal, timeout)
		let onDestroy = () => this.destroy()
		this.#client.signal.addEventListener('abort', onDestroy, { once: true })
		this.#active = true
		try {
			linked.signal.throwIfAborted()
			let text = this.text
			let parameters = executor ? this.#parameters : bindParameters(this.#parameters)
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
					if (!this.#disposed && !linked.signal.aborted) this.emit('metadata', metadata)
				},
			}
			let operation = executor
				? executor.execute(text, parameters, options)
				: this.#client.retrySession(
						{
							signal: linked.signal,
							idempotent: this.#idempotent,
							onRetry: (context: RetryContext) => this.emit('retry', context),
						},
						(session) => session.execute(text, parameters, options)
					)
			this.#promise = operation
				.then((result) => {
					linked.signal.throwIfAborted()
					this.#stats = result.stats
					if (this.#stats) this.emit('stats', this.#stats)
					linked.signal.throwIfAborted()
					let rows = result.resultSets.map((set) => set.rows) as ArrayifyTuple<T>
					this.emit('done', rows)
					linked.signal.throwIfAborted()
					return rows
				})
				.catch((error) => {
					if (
						!this.#disposed &&
						!this.#client.signal.aborted &&
						this.listenerCount('error')
					)
						this.emit('error', error)
					throw error
				})
				.finally(() => {
					this.#active = false
					controller.abort('Query completed.')
					linked[Symbol.dispose]()
					this.#client.signal.removeEventListener('abort', onDestroy)
				})
			return this.#promise
		} catch (error) {
			this.#active = false
			linked[Symbol.dispose]()
			this.#client.signal.removeEventListener('abort', onDestroy)
			throw error
		}
	}

	/** Returns the result of the query */
	then<TResult1 = ArrayifyTuple<T>, TResult2 = never>(
		onfulfilled?: (value: ArrayifyTuple<T>) => TResult1 | PromiseLike<TResult1>,
		onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>
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
		let queryText = this.#text
		if (this.#parameters) {
			for (let [name, value] of Object.entries(this.#parameters)) {
				// oxlint-disable no-unused-expressions
				name.startsWith('$') || (name = '$' + name)

				queryText = `DECLARE ${name} AS ${typeToString(value.type)};\n` + queryText
			}
		}

		return queryText
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

	/** Adds a parameter to the query */
	parameter(name: string, parameter: Value | undefined): Query<T> {
		name.startsWith('$') || (name = '$' + name)

		if (parameter === undefined) {
			delete this.#parameters[name]
			return this
		}

		this.#parameters[name] = parameter

		return this
	}

	/** Adds a parameter to the query */
	param(name: string, parameter: Value | undefined): Query<T> {
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
	values(): Query<[unknown][]> {
		this.#values = true

		return this
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
