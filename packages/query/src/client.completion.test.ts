import { expect, test } from 'vitest'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { TransactionCompletionError, YDBError } from '@ydbjs/error'

import { QueryClient } from './client.ts'
import { startClientServer } from './client.fixtures.ts'

test.for(['rollback', 'close'] as const)(
	'caller cancellation releases the session while the %s hook ignores its signal',
	async (stage, tc) => {
		using server = await startClientServer()
		using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
		let caller = new AbortController()
		let entered = Promise.withResolvers<void>()
		let release = Promise.withResolvers<void>()
		let hook = () => {
			entered.resolve()
			return release.promise
		}
		let operation = client.retryTransaction({ signal: caller.signal }, async (tx) => {
			if (stage === 'close') tx.onClose(hook)
			else {
				tx.onRollback(hook)
				throw new Error('application failure')
			}
		})
		let failure = operation.catch((error: unknown) => error)
		try {
			await abortable(tc.signal, entered.promise)
			let reason = new Error('caller stopped waiting')
			caller.abort(reason)
			let error = await failure
			expect(error instanceof TransactionCompletionError).toBe(stage === 'close')
			expect(error instanceof TransactionCompletionError ? error.cause : error).toBe(reason)
			await abortable(tc.signal, client.close())
			expect(server.deleted).toHaveLength(1)
			expect(server.commits).toHaveLength(stage === 'close' ? 1 : 0)
			expect(server.rollbacks).toHaveLength(stage === 'rollback' ? 1 : 0)
		} finally {
			release.resolve()
			await failure
		}
	}
)

test('cancellation after confirmed commit cannot request a surrounding callback retry', async (tc) => {
	using server = await startClientServer()
	using client = new QueryClient(server.driver)
	let caller = new AbortController()
	let release = Promise.withResolvers<void>()
	let reason = new YDBError(Status.ABORTED, [])
	try {
		let result = client.retrySession(
			{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
			() =>
				client.retryTransaction({ signal: caller.signal }, async (tx) => {
					await tx.execute('UPDATE data')
					tx.onClose(() => {
						caller.abort(reason)
						return release.promise
					})
				})
		)
		await expect(result).rejects.toBeInstanceOf(TransactionCompletionError)
		await abortable(tc.signal, client.close())
		expect(server.executions).toHaveLength(1)
		expect(server.commits).toHaveLength(1)
	} finally {
		release.resolve()
	}
})

test('nested scopes sharing cancellation cannot expose its reason as a retryable database error', async (tc) => {
	using server = await startClientServer()
	using client = new QueryClient(server.driver)
	let caller = new AbortController()
	let release = Promise.withResolvers<void>()
	let reason = new YDBError(Status.ABORTED, [])
	let attempts = 0
	try {
		let result = client.retrySession(
			{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
			() => {
				attempts++
				return client.retrySession({ signal: caller.signal }, () =>
					client.retryTransaction({ signal: caller.signal }, async (tx) => {
						await tx.execute('UPDATE data')
						tx.onClose(() => {
							caller.abort(reason)
							return release.promise
						})
					})
				)
			}
		)
		await expect(result).rejects.toMatchObject({ name: 'AbortError', cause: reason })
		await abortable(tc.signal, client.close())
		expect(attempts).toBe(1)
		expect(server.executions).toHaveLength(1)
		expect(server.commits).toHaveLength(1)
	} finally {
		release.resolve()
	}
})
