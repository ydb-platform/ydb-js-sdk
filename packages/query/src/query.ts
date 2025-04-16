import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	ExecMode,
	QueryServiceDefinition,
	type QueryStats,
	type SessionState,
	StatsMode,
	Syntax,
} from '@ydbjs/api/query'
import { type TypedValue, TypedValueSchema } from '@ydbjs/api/value'
import type { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { type RetryConfig, defaultRetryConfig, retry } from '@ydbjs/retry'
import { type Value, fromYdb, toJs } from '@ydbjs/value'
import { typeToString } from '@ydbjs/value/print'

import { storage } from './storage.js'

// Utility type to convert a tuple of types to a tuple of arrays of those types
type ArrayifyTuple<T extends unknown[]> = {
	[K in keyof T]: T[K][]
}

export class Query<T extends unknown[] = unknown[]>
	implements PromiseLike<ArrayifyTuple<T>>, AsyncDisposable {
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

	#isolation: 'serializableReadWrite' | 'snapshotReadOnly' | null = null

	#raw: boolean = false
	#values: boolean = false

	constructor(driver: Driver, text: string, params: Record<string, Value>) {
		this.#text = text
		this.#driver = driver
		this.#parameters = {}

		for (let key in params) {
			key.startsWith('$') || (key = '$' + key)
			this.#parameters[key] = params[key]
		}
	}

	/* oxlint-disable max-lines-per-function  */
	async #execute(): Promise<ArrayifyTuple<T>> {
		let store = storage.getStore() || {}

		if (this.#disposed) {
			throw new Error('Query has been disposed.')
		}

		// If we already have a promise, return it without executing the query again
		if (this.#promise) {
			return this.#promise
		}

		if (this.#active) {
			throw new Error('Query is already executing.')
		}

		this.#active = true

		let signal = this.#controller.signal
		if (store.signal) {
			signal = AbortSignal.any([signal, store.signal])
		} if (this.#signal) {
			signal = AbortSignal.any([signal, this.#signal])
		} if (this.#timeout) {
			signal = AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)])
		}

		let retryConfig: RetryConfig = {
			...defaultRetryConfig,
			signal,
			idempotent: this.#idempotent,
		}

		this.#promise = retry(retryConfig, async (signal) => {
			await this.#driver.ready(signal)
			let client = this.#driver.createClient(QueryServiceDefinition, store?.nodeId)

			if (!store?.sessionId) {
				let sessionResponse = await client.createSession({}, { signal })
				if (sessionResponse.status !== StatusIds_StatusCode.SUCCESS) {
					throw new YDBError(sessionResponse.status, sessionResponse.issues)
				}

				store.nodeId = sessionResponse.nodeId
				store.sessionId = sessionResponse.sessionId

				client = this.#driver.createClient(QueryServiceDefinition, sessionResponse.nodeId)
				this.#cleanup.push(() => client.deleteSession({ sessionId: sessionResponse.sessionId }))

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
			}

			let parameters: Record<string, TypedValue> = {}
			for (let key in this.#parameters) {
				parameters[key] = create(TypedValueSchema, {
					type: this.#parameters[key].type.encode(),
					value: this.#parameters[key].encode(),
				})
			}

			let stream = client.executeQuery(
				{
					sessionId: store.sessionId,
					execMode: ExecMode.EXECUTE,
					// If we have a transactionId, we should use it
					// If we have an isolation level, we should use it
					// Otherwise, we should not use a transaction.
					txControl: store.transactionId ? {
						txSelector: {
							case: "txId",
							value: store.transactionId,
						},
					} : this.#isolation ? {
						commitTx: true,
						txSelector: {
							case: "beginTx",
							value: {
								txMode: {
									case: this.#isolation,
									value: {},
								}
							}
						}
					} : undefined,
					query: {
						case: 'queryContent',
						value: {
							syntax: this.#syntax,
							text: this.text,
						},
					},
					parameters,
					statsMode: this.#statsMode,
					poolId: this.#poolId,
				},
				{ signal }
			)

			let results = [] as ArrayifyTuple<T>

			for await (let part of stream) {
				signal.throwIfAborted()

				if (part.status !== StatusIds_StatusCode.SUCCESS) {
					throw new YDBError(part.status, part.issues)
				}

				if (part.execStats) {
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
						let column = part.resultSet.columns[j]
						let value = part.resultSet.rows[i].items[j]

						if (this.#values) {
							result.push(this.#raw ? value : toJs(fromYdb(value, column.type!)))
							continue
						}

						result[column.name] = this.#raw ? value : toJs(fromYdb(value, column.type!))
					}

					results[Number(part.resultSetIndex)].push(result)
				}
			}

			return results
		}).finally(() => {
			this.#active = false
			this.#controller.abort('Query completed.')
		})

		return await this.#promise
	}

	/** Returns the result of the query */
	/* oxlint-disable unicorn/no-thenable */
	async then<TResult1 = ArrayifyTuple<T>, TResult2 = never>(
		onfulfilled?: (value: ArrayifyTuple<T>) => TResult1 | PromiseLike<TResult1>,
		onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>
	): Promise<TResult1 | TResult2> {
		return await this.#execute().then(onfulfilled, onrejected)
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

	/** Sets the idempotent flag for the query */
	idempotent(idempotent: boolean): Query<T> {
		this.#idempotent = idempotent

		return this
	}

	/**
	 * Configure transaction isolation for single execute call.
	 * If not set or null, the query will be executed without transaction.
	 * If set, the query will be executed in a transaction (inline begin and commit)
	 * with the specified isolation level.
	 */
	isolation(isolation: 'serializableReadWrite' | 'snapshotReadOnly' | null) {
		this.#isolation = isolation

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
	values(): Query<unknown[]> {
		this.#values = true

		return this
	}

	/** Returns raw values */
	raw(): Query<T> {
		this.#raw = true

		return this
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.#controller.abort('Query disposed.')
		await Promise.all(this.#cleanup.map((fn) => fn()))
		this.#cleanup = []
		this.#promise = null
		this.#disposed = true
	}
}
