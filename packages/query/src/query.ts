import { create } from "@bufbuild/protobuf"
import { StatusIds_StatusCode } from "@ydbjs/api/operation"
import { ExecMode, QueryServiceDefinition, Syntax, type SessionState } from "@ydbjs/api/query"
import { TypedValueSchema, type TypedValue } from "@ydbjs/api/value"
import type { Driver } from "@ydbjs/core"
import { YDBError } from "@ydbjs/error"
import { retry, type RetryConfig } from "@ydbjs/retry"
import { exponential } from "@ydbjs/retry/strategy"
import { fromYdb, toJs, type Value } from "@ydbjs/value"
import { ClientError, Status } from "nice-grpc"

// Utility type to convert a tuple of types to a tuple of arrays of those types
type ArrayifyTuple<T extends any[]> = {
	[K in keyof T]: T[K][]
}

type WithQueryStats<T> = T & { stats: QueryResultStats }

export interface QueryResultStats { }

export class Query<T extends any[] = unknown[], S extends boolean = false> implements PromiseLike<S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>>, AsyncDisposable {
	#driver: Driver
	#promise: (Promise<S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>>) | null = null
	#cleanup: Promise<unknown>[] = []

	#text: string
	#parameters: Record<string, Value>

	#active: boolean = false
	#disposed: boolean = false
	#cancelled: boolean = false
	#controller: AbortController = new AbortController()

	#signal: AbortSignal | undefined
	#timeout: number | undefined

	#syntax: Syntax = Syntax.YQL_V1
	#poolId: string | undefined

	#raw: boolean = false
	#values: boolean = false

	constructor(driver: Driver, text: string, params: Record<string, Value>) {
		this.#text = text
		this.#driver = driver
		this.#parameters = params
	}

	async #execute(): Promise<S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>> {
		if (this.#disposed) {
			throw new Error("Query has been disposed.")
		}

		// If we already have a promise, return it without executing the query again
		if (this.#promise) {
			return this.#promise;
		}

		if (this.#active) {
			throw new Error("Query is already executing.")
		}

		this.#active = true

		let signal = this.#signal ? AbortSignal.any([this.#signal, this.#controller.signal]) : this.#controller.signal
		if (this.#timeout) {
			let timeout = AbortSignal.timeout(this.#timeout)
			signal = AbortSignal.any([signal, timeout])
		}

		signal.throwIfAborted()

		let retryConfig: RetryConfig = {
			retry: (err) => {
				return (err instanceof ClientError && err.code !== Status.CANCELLED)
					|| (err instanceof YDBError && err.code !== StatusIds_StatusCode.BAD_REQUEST)
					|| (err instanceof YDBError && err.code !== StatusIds_StatusCode.GENERIC_ERROR)
					|| (err instanceof Error && err.name !== 'TimeoutError')
					|| (err instanceof Error && err.name !== 'AbortError')
			},
			signal,
			budget: 5,
			strategy: exponential(10)
		}

		this.#promise = retry(retryConfig, async () => {
			await this.#driver.ready(signal)
			let client = this.#driver.createClient(QueryServiceDefinition)

			let sessionResponse = await client.createSession({}, { signal })
			if (sessionResponse.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(sessionResponse.status, sessionResponse.issues)
			}

			client = this.#driver.createClient(QueryServiceDefinition, sessionResponse.nodeId)

			let attachSession = Promise.withResolvers<SessionState>();
			(async (stream: AsyncIterable<SessionState>) => {
				try {
					for await (let state of stream) {
						attachSession.resolve(state)
					}
				} catch (err) { attachSession.reject(err) }
			})(client.attachSession({ sessionId: sessionResponse.sessionId }, { signal }))

			let attachSessionResult = await attachSession.promise
			if (attachSessionResult.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(attachSessionResult.status, attachSessionResult.issues)
			}

			let parameters: Record<string, TypedValue> = {}
			for (let key in this.#parameters) {
				parameters[key] = create(TypedValueSchema, { type: this.#parameters[key].type.encode(), value: this.#parameters[key].encode() })
			}

			let stream = client.executeQuery({
				sessionId: sessionResponse.sessionId,
				execMode: ExecMode.EXECUTE,
				query: {
					case: 'queryContent',
					value: {
						syntax: this.#syntax,
						text: this.#text,
					}
				},
				parameters,
				poolId: this.#poolId
			}, { signal })

			let results = [] as unknown as S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>

			for await (let part of stream) {
				if (part.status !== StatusIds_StatusCode.SUCCESS) {
					throw new YDBError(part.status, part.issues)
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

			if (sessionResponse.sessionId) {
				this.#cleanup.push(client.deleteSession({ sessionId: sessionResponse.sessionId }))
			}

			return results
		})
			.finally(() => {
				this.#active = false
				this.#controller.abort("Query completed.")
			})

		return this.#promise
	}

	async then<TResult1 = S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>, TResult2 = never>(
		onfulfilled?: ((value: S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>) => TResult1 | PromiseLike<TResult1>) | null | undefined,
		onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined
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

	syntax(syntax: Exclude<Syntax, Syntax.UNSPECIFIED>): Query<T, S> {
		this.#syntax = syntax

		return this
	}

	pool(poolId: string): Query<T, S> {
		this.#poolId = poolId

		return this
	}

	/** Adds a parameter to the query */
	parameter(name: string, parameter: null | string | number | boolean | Value): Query<T, S> {
		return this
	}

	/** Adds a parameter to the query */
	param(name: string, parameter: null | string | number | boolean | Value): Query<T, S> {
		return this
	}

	/** Returns the query execution statistics */
	stats(): QueryResultStats {
		return {}
	}

	/** Returns a query with statistics enabled */
	withStats(): Query<T, true> {
		// @ts-expect-error
		return this
	}

	/** Sets the query timeout */
	timeout(timeout: number): Query<T, S> {
		this.#timeout = timeout

		return this
	}

	/** Cancels the executing query */
	cancel(): Query<T, S> {
		this.#controller.abort("Query cancelled by user.")
		this.#cancelled = true

		return this
	}

	signal(signal: AbortSignal): Query<T, S> {
		this.#signal = signal

		return this
	}

	/** Executes the query */
	execute(): Query<T, S> {
		this.#execute()

		return this
	}

	/** Returns only the values from the query result */
	values(): Query<unknown[], S> {
		this.#values = true
		return this
	}

	/** Returns raw values */
	raw(): Query<T, S> {
		this.#raw = true
		return this
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.#controller.abort("Query disposed.")
		await Promise.all(this.#cleanup)
		this.#cleanup = []
		this.#promise = null
		this.#disposed = true
	}
}
