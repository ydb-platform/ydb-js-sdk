import { EventEmitter } from 'node:events'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	ExecMode,
	QueryServiceDefinition,
	type QueryStats,
	StatsMode,
	Syntax,
	type TransactionControl,
	TransactionControlSchema,
} from '@ydbjs/api/query'
import { type TypedValue, TypedValueSchema } from '@ydbjs/api/value'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { type RetryConfig, type RetryContext, defaultRetryConfig, retry } from '@ydbjs/retry'
import { type Value, fromYdb, toJs } from '@ydbjs/value'
import { typeToString } from '@ydbjs/value/print'
import type { Metadata } from 'nice-grpc'

import { ctx } from './ctx.js'

let dbg = loggers.query

// Utility type to convert a tuple of types to a tuple of arrays of those types
type ArrayifyTuple<T extends any[]> = {
	[K in keyof T]: T[K][]
}

export type QueryEventMap = {
	'done': [ArrayifyTuple<any>],
	'retry': [RetryContext],
	'error': [unknown],
	'stats': [QueryStats],
	'cancel': [],
	'metadata': [Metadata],
}

export class Query<T extends any[] = unknown[]> extends EventEmitter<QueryEventMap> implements PromiseLike<ArrayifyTuple<T>>, AsyncDisposable {
	#driver: Driver
	#promise: Promise<ArrayifyTuple<T>> | null = null
	#cleanup: (() => Promise<unknown>)[] = []

	#text: string
	#parameters: Record<string, Value>
	#idempotent: boolean = false

	#active: boolean = false
	#disposed: boolean = false
	#cancelled: boolean = false
	#controller: AbortController = new AbortController()

	#signal: AbortSignal | undefined
	#timeout: number | undefined

	#syntax: Syntax = Syntax.YQL_V1
	#poolId: string | undefined

	#stats: QueryStats | undefined
	#statsMode: StatsMode = StatsMode.UNSPECIFIED

	#isolation: 'implicit' | 'serializableReadWrite' | 'snapshotReadOnly' | 'onlineReadOnly' | 'staleReadOnly' = 'implicit'
	#isolationSettings: { allowInconsistentReads: boolean } | {} = {}

	#raw: boolean = false
	#values: boolean = false

	constructor(driver: Driver, text: string, params: Record<string, Value>) {
		super()

		this.#text = text
		this.#driver = driver
		this.#parameters = {}

		for (let key in params) {
			key.startsWith('$') || (key = '$' + key)
			this.#parameters[key] = params[key]!
		}
	}

	static get [Symbol.species]() {
		return Promise;
	}

	/* oxlint-disable max-lines-per-function  */
	async #execute(): Promise<ArrayifyTuple<T>> {
		let { nodeId, sessionId, transactionId, signal } = ctx.getStore() || {}

		if (this.#disposed) {
			dbg.log('query disposed, aborting execution')
			throw new Error('Query has been disposed.')
		}

		// If we already have a promise, return it without executing the query again
		if (this.#promise) {
			dbg.log('query already has a promise, returning cached result')
			return this.#promise
		}

		if (this.#active) {
			dbg.log('query is already executing, aborting')
			throw new Error('Query is already executing.')
		}

		dbg.log('starting query execution: %s', this.text)
		this.#active = true

		signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal
		if (this.#signal) {
			signal = AbortSignal.any([signal, this.#signal])
		} if (this.#timeout) {
			signal = AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)])
		}

		let retryConfig: RetryConfig = {
			...defaultRetryConfig,
			signal,
			idempotent: this.#idempotent,
			onRetry: (retryCtx) => {
				dbg.log('retrying query, attempt %d, error: %O', retryCtx.attempt, retryCtx.error)
				this.emit('retry', retryCtx)
			}
		}

		await this.#driver.ready(signal)

		this.#promise = retry(retryConfig, async (signal) => {
			dbg.log('creating query client for nodeId: %s', nodeId)
			let client = this.#driver.createClient(QueryServiceDefinition, nodeId)

			if (!sessionId) {
				dbg.log('creating new session')
				let sessionResponse = await client.createSession({}, { signal })
				if (sessionResponse.status !== StatusIds_StatusCode.SUCCESS) {
					dbg.log('failed to create session, status: %d', sessionResponse.status)
					throw new YDBError(sessionResponse.status, sessionResponse.issues)
				}

				nodeId = sessionResponse.nodeId
				sessionId = sessionResponse.sessionId

				client = this.#driver.createClient(QueryServiceDefinition, nodeId)
				this.#cleanup.push(async () => {
					dbg.log('deleting session %s', sessionId)
					await client.deleteSession({ sessionId: sessionId! })
				})

				let attachSession = client.attachSession({ sessionId }, { signal })[Symbol.asyncIterator]()
				let attachSessionResult = await attachSession.next()
				if (attachSessionResult.value.status !== StatusIds_StatusCode.SUCCESS) {
					dbg.log('failed to attach session, status: %d', attachSessionResult.value.status)
					throw new YDBError(attachSessionResult.value.status, attachSessionResult.value.issues)
				}
				dbg.log('session %s created and attached', sessionId)
			}

			let parameters: Record<string, TypedValue> = {}
			for (let key in this.#parameters) {
				parameters[key] = create(TypedValueSchema, {
					type: this.#parameters[key]!.type.encode(),
					value: this.#parameters[key]!.encode(),
				})
			}

			// If we have a transactionId, we should use it
			// If we have an isolation level, we should use it
			let txControl: TransactionControl | undefined
			if (transactionId) {
				txControl = create(TransactionControlSchema, {
					txSelector: {
						case: "txId",
						value: transactionId,
					},
				})
			} else if (this.#isolation !== "implicit") {
				txControl = create(TransactionControlSchema, {
					commitTx: true,
					txSelector: {
						case: "beginTx",
						value: {
							txMode: {
								case: this.#isolation,
								value: this.#isolationSettings as {},
							}
						}
					}
				})
			}

			let stream = client.executeQuery(
				{
					sessionId,
					execMode: ExecMode.EXECUTE,
					query: {
						case: 'queryContent',
						value: {
							syntax: this.#syntax,
							text: this.text,
						},
					},
					parameters,
					statsMode: this.#statsMode,
					...(this.#poolId && { poolId: this.#poolId }),
					...(txControl && { txControl }),
				},
				{
					signal,
					onTrailer: (trailer) => {
						this.emit('metadata', trailer)
					},
				}
			)

			let results = [] as ArrayifyTuple<T>

			for await (let part of stream) {
				signal.throwIfAborted()

				if (part.status !== StatusIds_StatusCode.SUCCESS) {
					dbg.log('query part failed, status: %d', part.status)
					throw new YDBError(part.status, part.issues)
				}

				if (part.execStats) {
					dbg.log('received query stats')
					this.#stats = part.execStats
				}

				if (!part.resultSet) {
					continue
				}

				while (part.resultSetIndex >= results.length) {
					results.push([])
				}

				for (let i = 0; i < part.resultSet.rows.length; i++) {
					let result: any = this.#values ? [] : {}

					for (let j = 0; j < part.resultSet.columns.length; j++) {
						let column = part.resultSet.columns[j]!
						let value = part.resultSet.rows[i]!.items[j]!

						if (this.#values) {
							result.push(this.#raw ? value : toJs(fromYdb(value, column.type!)))
							continue
						}

						result[column.name] = this.#raw ? value : toJs(fromYdb(value, column.type!))
					}

					results[Number(part.resultSetIndex)]!.push(result)
				}
			}

			dbg.log('query executed successfully')
			return results
		})
			.then((results) => {
				if (this.#stats) {
					this.emit('stats', this.#stats)
				}

				this.emit('done', results)

				return results
			})
			.catch((err) => {
				this.emit('error', err)
				throw err
			})
			.finally(async () => {
				this.#active = false
				this.#controller.abort('Query completed.')

				this.#cleanup.forEach((fn) => void fn())
				this.#cleanup = []
			})

		return this.#promise
	}

	/** Returns the result of the query */
	/* oxlint-disable unicorn/no-thenable */
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
	 *  - 'onlineReadOnly' — online read-only
	 *  - 'staleReadOnly' — stale read-only
	 *  - 'implicit' — isolation is not set, server decides
	 *  - 'implicit' is the default value
	 * @param settings Additional options, e.g., allowInconsistentReads — allow inconsistent reads only with 'onlineReadOnly'
	 * @returns The current instance for chaining
	 */
	isolation(mode: 'implicit' | 'serializableReadWrite' | 'snapshotReadOnly' | 'onlineReadOnly' | 'staleReadOnly', settings: { allowInconsistentReads: boolean } | {} | undefined = {}) {
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
		this.#controller.abort('Query cancelled by user.')
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
		void this.#execute()

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
	 * This method is called automatically when the query is done.
	 * It is recommended to call this method explicitly when the query is no longer needed.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) {
			return
		}

		this.#controller.abort('Query disposed.')
		await Promise.all(this.#cleanup.map((fn) => fn()))
		this.#cleanup = []
		this.#promise = null
		this.#disposed = true
	}

	[Symbol.dispose](): void {
		this.dispose()
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.dispose()
	}
}
