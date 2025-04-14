import type { Abortable } from 'node:events'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition, type SessionState } from '@ydbjs/api/query'
import type { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { defaultRetryConfig, retry } from '@ydbjs/retry'
import { fromJs, type Value } from '@ydbjs/value'

import { Query } from './query.js'
import { storage } from './storage.js'

type SQL = <T extends any[] = unknown[], P extends any[] = unknown[]>(
	strings: string | TemplateStringsArray,
	...values: P
) => Query<T>

interface SessionContextCallback<T> {
	(signal: AbortSignal): Promise<T>
}

interface TransactionExecuteOptions extends Abortable {
	iso?: 'serializableReadWrite' | 'onlineReadOnly' | 'staleReadOnly' | 'snapshotReadOnly'
	allowInconsistentReads?: boolean
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

		storage.enterWith(storage.getStore() ?? {})

		return new Query(driver, text, params)
	}

	function txIml<T = unknown>(fn: TransactionContextCallback<T>): Promise<T>
	function txIml<T = unknown>(options: TransactionExecuteOptions, fn: TransactionContextCallback<T>): Promise<T>
	async function txIml<T = unknown>(optOrFn: TransactionExecuteOptions | TransactionContextCallback<T>, fn?: TransactionContextCallback<T>): Promise<T> {
		await driver.ready()
		let store = storage.getStore() || {}
		let client = driver.createClient(QueryServiceDefinition)

		let caller = (typeof optOrFn === "function" ? optOrFn : fn)
		let options = typeof optOrFn === "function" ? ({} as TransactionExecuteOptions) : optOrFn
		options.iso ??= "serializableReadWrite"
		options.allowInconsistentReads ??= false

		return retry({ ...defaultRetryConfig, signal: options.signal }, async (signal) => {
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
				txSettings:
					options.iso === 'snapshotReadOnly' ? { txMode: { case: "snapshotReadOnly", value: {} } } :
						options.iso === 'onlineReadOnly' ? { txMode: { case: "onlineReadOnly", value: { allowInconsistentReads: options.allowInconsistentReads } } } :
							options.iso === 'staleReadOnly' ? { txMode: { case: "staleReadOnly", value: {} } } :
								options.iso === "serializableReadWrite" ? { txMode: { case: "serializableReadWrite", value: {} } } : undefined,
			}, { signal })
			if (beginTransactionResult.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(beginTransactionResult.status, beginTransactionResult.issues)
			}

			store.transactionId = beginTransactionResult.txMeta?.id

			try {
				let result = await storage.run(store, () => caller!(yql, signal))
				let commitResult = await client.commitTransaction({ sessionId: store.sessionId, txId: store.transactionId }, { signal })
				if (commitResult.status !== StatusIds_StatusCode.SUCCESS) {
					throw new YDBError(commitResult.status, commitResult.issues)
				}

				return result
			} catch (err) {
				await client.rollbackTransaction({ sessionId: store.sessionId, txId: store.transactionId })
				throw err
			} finally {
				client.deleteSession({ sessionId: sessionResponse.sessionId })
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
