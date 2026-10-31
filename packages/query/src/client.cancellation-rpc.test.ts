import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { RollbackTransactionResponseSchema, SessionStateSchema } from '@ydbjs/api/query'
import { expect, test } from 'vitest'

import { QueryClient } from './client.ts'
import { onAbort, startClientServer } from './client.fixtures.ts'

test('caller cancellation interrupts the first attach response and releases acquisition capacity', async (tc) => {
	let entered = Promise.withResolvers<AbortSignal>()
	let stopped = Promise.withResolvers<void>()
	let sessions: string[] = []
	using server = await startClientServer({
		async *attachSession(request, context) {
			sessions.push(request.sessionId)
			if (sessions.length === 1) {
				entered.resolve(context.signal)
				await onAbort(context.signal)
				stopped.resolve()
				context.signal.throwIfAborted()
			}
			yield create(SessionStateSchema, { status: Status.SUCCESS })
			await onAbort(context.signal)
		},
	})
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let caller = new AbortController()
	let reason = new Error('cancel pending attach')
	let callbacks = 0
	let retries = 0
	let outcome = client
		.retrySession(
			{
				signal: caller.signal,
				idempotent: true,
				retry: { budget: 3, strategy: 0 },
				onRetry: () => retries++,
			},
			async (session) => {
				callbacks++
				return session.execute('SELECT cancelled')
			}
		)
		.catch((error: unknown) => error)
	let signal = await abortable(tc.signal, entered.promise)
	caller.abort(reason)
	expect(await abortable(tc.signal, outcome)).toBe(reason)
	await abortable(tc.signal, stopped.promise)
	expect(signal.aborted).toBe(true)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT fresh')
	)
	await abortable(tc.signal, client.close())
	expect(result.resultSets[0]?.rows).toEqual([{ id: 1 }])
	expect(callbacks).toBe(0)
	expect(retries).toBe(0)
	expect(sessions).toHaveLength(2)
	expect(sessions[1]).not.toBe(sessions[0])
	expect(server.executions).toHaveLength(1)
	expect(server.executions[0]?.sessionId).toBe(sessions[1])
	expect(server.begins).toHaveLength(0)
	expect(server.commits).toHaveLength(0)
})

test('caller cancellation during begin prevents the transaction body and retries', async (tc) => {
	let entered = Promise.withResolvers<AbortSignal>()
	let stopped = Promise.withResolvers<void>()
	using server = await startClientServer({
		async beginTransaction(_request, context) {
			entered.resolve(context.signal)
			await onAbort(context.signal)
			stopped.resolve()
			throw context.signal.reason
		},
	})
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let caller = new AbortController()
	let reason = new Error('cancel pending begin')
	let callbacks = 0
	let retries = 0
	let outcome = client
		.retryTransaction(
			{
				signal: caller.signal,
				idempotent: true,
				retry: { budget: 3, strategy: 0 },
				onRetry: () => retries++,
			},
			async (transaction) => {
				callbacks++
				return transaction.execute('UPDATE cancelled')
			}
		)
		.catch((error: unknown) => error)
	let signal = await abortable(tc.signal, entered.promise)
	caller.abort(reason)
	expect(await abortable(tc.signal, outcome)).toBe(reason)
	await abortable(tc.signal, stopped.promise)
	expect(signal.aborted).toBe(true)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT fresh')
	)
	await abortable(tc.signal, client.close())
	expect(result.resultSets[0]?.rows).toEqual([{ id: 1 }])
	expect(callbacks).toBe(0)
	expect(retries).toBe(0)
	expect(server.begins).toHaveLength(1)
	expect(server.executions).toHaveLength(1)
	expect(server.executions[0]?.sessionId).not.toBe(server.begins[0]?.sessionId)
	expect(server.commits).toHaveLength(0)
	expect(server.rollbacks).toHaveLength(0)
})

test('caller cancellation during commit preserves uncertainty while close drains rollback', async (tc) => {
	let entered = Promise.withResolvers<AbortSignal>()
	let stopped = Promise.withResolvers<void>()
	let rollbackEntered = Promise.withResolvers<AbortSignal>()
	let finishRollback = Promise.withResolvers<void>()
	using server = await startClientServer({
		async commitTransaction(_request, context) {
			entered.resolve(context.signal)
			await onAbort(context.signal)
			stopped.resolve()
			throw context.signal.reason
		},
		async rollbackTransaction(_request, context) {
			rollbackEntered.resolve(context.signal)
			await abortable(context.signal, finishRollback.promise)
			return create(RollbackTransactionResponseSchema, { status: Status.NOT_FOUND })
		},
	})
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let caller = new AbortController()
	let reason = new Error('cancel pending commit')
	let callbacks = 0
	let retries = 0
	let closures: boolean[] = []
	let outcome = client
		.retryTransaction(
			{
				signal: caller.signal,
				retry: { budget: 3, strategy: 0 },
				onRetry: () => retries++,
			},
			async (transaction) => {
				callbacks++
				transaction.onClose((committed) => {
					closures.push(committed)
				})
				await transaction.execute('UPDATE uncertain')
				return 'committed'
			}
		)
		.catch((error: unknown) => error)
	try {
		let signal = await abortable(tc.signal, entered.promise)
		caller.abort(reason)
		expect(await abortable(tc.signal, outcome)).toBe(reason)
		await abortable(tc.signal, stopped.promise)
		expect(signal.aborted).toBe(true)
		let cleanupSignal = await abortable(tc.signal, rollbackEntered.promise)
		expect(cleanupSignal.aborted).toBe(false)
		let fresh = client.retrySession({ signal: tc.signal }, (session) =>
			session.execute('SELECT fresh')
		)
		let closed = false
		let closing = client.close().then(() => {
			closed = true
			return undefined
		})
		let result = await abortable(tc.signal, fresh)
		expect(result.resultSets[0]?.rows).toEqual([{ id: 1 }])
		expect(closed).toBe(false)
		expect(closures).toEqual([])
		finishRollback.resolve()
		await abortable(tc.signal, closing)
		expect(await outcome).toBe(reason)
		expect(callbacks).toBe(1)
		expect(retries).toBe(0)
		expect(closures).toEqual([false])
		expect(server.begins).toHaveLength(1)
		expect(server.commits).toHaveLength(1)
		expect(server.rollbacks).toHaveLength(1)
		expect(server.executions).toHaveLength(2)
		expect(server.executions[1]?.sessionId).not.toBe(server.executions[0]?.sessionId)
	} finally {
		finishRollback.resolve()
	}
})
