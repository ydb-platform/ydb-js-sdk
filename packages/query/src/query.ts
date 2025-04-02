import { create } from "@bufbuild/protobuf"
import { StatusIds_StatusCode } from "@ydbjs/api/operation"
import { ExecMode, Syntax, type QueryServiceClient, type SessionState } from "@ydbjs/api/query"
import { TypedValueSchema, type TypedValue } from "@ydbjs/api/value"
import { toJs } from "@ydbjs/value"
import { fromYdb } from "@ydbjs/value"
import { type Value } from "@ydbjs/value"

// Utility type to convert a tuple of types to a tuple of arrays of those types
type ArrayifyTuple<T extends any[]> = {
	[K in keyof T]: T[K][]
}

type WithQueryStats<T> = T & { stats: QueryResultStats }

export interface QueryResultStats { }

export class Query<T extends any[] = unknown[], S extends boolean = false> implements PromiseLike<S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>> {
	#client: QueryServiceClient
	#execute = Promise.withResolvers<S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>>()

	#text: string
	#parameters: Record<string, Value>

	#active: boolean = false
	#cancelled: boolean = false

	#signal: AbortSignal | undefined
	#timeout: number | undefined

	#syntax: Syntax = Syntax.YQL_V1
	#poolId: string | undefined

	#raw: boolean = false
	#values: boolean = false

	constructor(client: QueryServiceClient, text: string, params: Record<string, Value>) {
		this.#client = client
		this.#text = text
		this.#parameters = params
	}

	async #executeQuery() {
		if (this.#active) {
			return
		}

		if (this.#cancelled) {
			this.#execute.reject(new Error("Query cancelled."))
			return
		}

		this.#active = true

		let signal = this.#signal
		if (this.#timeout) {
			let timeout = AbortSignal.timeout(this.#timeout)
			signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout
		}

		signal?.addEventListener("abort", () => {
			this.#execute.reject(new Error("Query cancelled."))
			this.#cancelled = true
			this.#active = false
		})

		let sessionResponse = await this.#client.createSession({}, { signal })
		if (sessionResponse.status !== StatusIds_StatusCode.SUCCESS) {
			this.#execute.reject(new Error("Failed to create session."))
			this.#active = false
			return
		}

		let attachSessionResult = Promise.withResolvers<SessionState>();
		(async (stream: AsyncIterable<SessionState>) => {
			try {
				for await (let state of stream) {
					attachSessionResult.resolve(state)
				}
			} catch (err) { attachSessionResult.reject(err) }
		})(this.#client.attachSession({ sessionId: sessionResponse.sessionId }, { signal }))

		if ((await attachSessionResult.promise).status !== StatusIds_StatusCode.SUCCESS) {
			this.#execute.reject(new Error("Failed to attach session. " + (await attachSessionResult.promise).status))
			this.#active = false
			return
		}

		let parameters: Record<string, TypedValue> = {}
		for (let key in this.#parameters) {
			parameters[key] = create(TypedValueSchema, { type: this.#parameters[key].type.encode(), value: this.#parameters[key].encode() })
		}

		let stream = this.#client.executeQuery({
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

		try {
			for await (let part of stream) {
				if (part.status !== StatusIds_StatusCode.SUCCESS) {
					throw new Error(`Failed to read query result part. ${JSON.stringify(part.issues)}`)
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
		} catch (err) {
			this.#execute.reject(err)
		} finally {
			this.#execute.resolve(results)
			this.#active = false

			if (sessionResponse.sessionId) {
				try { await this.#client.deleteSession({ sessionId: sessionResponse.sessionId }) } catch (_) { }
			}
		}
	}

	async then<TResult1 = S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>, TResult2 = never>(
		onfulfilled?: ((value: S extends true ? WithQueryStats<ArrayifyTuple<T>> : ArrayifyTuple<T>) => TResult1 | PromiseLike<TResult1>) | null | undefined,
		onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined
	): Promise<TResult1 | TResult2> {
		this.#executeQuery()

		return this.#execute.promise.then(onfulfilled, onrejected)
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
		this.#execute.reject(new Error("Query cancelled."))
		this.#cancelled = true

		return this
	}

	signal(signal: AbortSignal): Query<T, S> {
		this.#signal = signal

		return this
	}

	/** Executes the query */
	execute(): Query<T, S> {
		this.#executeQuery()

		return this
	}

	/** Returns only the values from the query result */
	values(): Query<unknown[], S> {
		this.#values = true
		// @ts-expect-error
		return this
	}

	/** Returns raw values */
	raw(): Query<T, S> {
		this.#raw = true

		return this
	}
}
