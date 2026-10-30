import { channel } from 'node:diagnostics_channel'

import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import {
	DiscoveryServiceDefinition,
	ListEndpointsResponseSchema,
	ListEndpointsResultSchema,
} from '@ydbjs/api/discovery'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { QueryServiceDefinition } from '@ydbjs/api/query'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import { onAbort, resultPart, startClientServer, statusPart } from './client.fixtures.ts'
import { QueryClient, query } from './index.ts'

// Only timeout delivery is controlled; readiness, sessions and RPCs use the real transport.
function controlledTimeout(milliseconds: number) {
	let controller = new AbortController()
	let original = AbortSignal.timeout.bind(AbortSignal)
	let calls = 0
	let spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((duration) => {
		if (duration !== milliseconds) return original(duration)
		calls++
		return controller.signal
	})
	return {
		controller,
		get calls() {
			return calls
		},
		[Symbol.dispose]() {
			spy.mockRestore()
		},
	}
}

test.for(['abort', 'timeout'] as const)(
	'query %s during readiness leaves shared discovery usable',
	async (mode, tc) => {
		using server = new Server()
		let entered = Promise.withResolvers<AbortSignal>()
		let release = Promise.withResolvers<void>()
		let creates = 0
		let port = 0
		server.add(DiscoveryServiceDefinition, {
			async listEndpoints(_request, context) {
				entered.resolve(context.signal)
				await abortable(context.signal, release.promise)
				return create(ListEndpointsResponseSchema, {
					operation: {
						ready: true,
						status: Status.SUCCESS,
						result: anyPack(
							ListEndpointsResultSchema,
							create(ListEndpointsResultSchema, {
								endpoints: [{ address: '127.0.0.1', port, nodeId: 1 }],
							})
						),
					},
				})
			},
		})
		server.add(QueryServiceDefinition, {
			createSession() {
				creates++
				throw new Error('session acquisition before readiness')
			},
		})
		port = await server.listen('127.0.0.1:0')
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`)
		using client = new QueryClient(driver)
		let caller = new AbortController()
		let callbacks = 0
		let reason = new Error('caller cancelled readiness')
		let operation = client
			.retrySession(
				mode === 'timeout' ? { timeout: 0, signal: tc.signal } : { signal: caller.signal },
				async () => {
					callbacks++
				}
			)
			.catch((error: unknown) => error)
		try {
			let discovery = await abortable(tc.signal, entered.promise)
			if (mode === 'abort') caller.abort(reason)
			let error = await abortable(tc.signal, operation)
			expect(mode === 'abort' ? error : (error as Error).name).toBe(
				mode === 'abort' ? reason : 'TimeoutError'
			)
			await abortable(tc.signal, client.close())
			expect(callbacks).toBe(0)
			expect(creates).toBe(0)
			expect(discovery.aborted).toBe(false)
			release.resolve()
			await driver.ready(tc.signal)
		} finally {
			caller.abort()
			release.resolve()
		}
	}
)

test('cancelling a queued operation leaves the active sibling and its session usable', async (tc) => {
	using server = await startClientServer()
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let entered = Promise.withResolvers<void>()
	let release = Promise.withResolvers<void>()
	let waiting = Promise.withResolvers<void>()
	let queued = channel('ydb:query.session.waiter.enqueued')
	let listener = (event: unknown) => {
		if ((event as { driver: unknown }).driver === server.driver.identity) waiting.resolve()
	}
	queued.subscribe(listener)
	let first = client
		.retrySession({ signal: tc.signal }, async (session) => {
			entered.resolve()
			await abortable(tc.signal, release.promise)
			return session.execute('SELECT active')
		})
		.catch((error: unknown) => error)
	let caller = new AbortController()
	let callbacks = 0
	try {
		await abortable(tc.signal, entered.promise)
		let second = client
			.retrySession({ signal: caller.signal, idempotent: true }, async () => {
				callbacks++
			})
			.catch((error: unknown) => error)
		await abortable(tc.signal, waiting.promise)
		let reason = new Error('cancelled in the pool queue')
		caller.abort(reason)
		expect(await abortable(tc.signal, second)).toBe(reason)
		release.resolve()
		expect(await abortable(tc.signal, first)).toMatchObject({
			resultSets: [{ rows: [{ id: 1 }] }],
		})
		await abortable(tc.signal, client.close())
		expect(callbacks).toBe(0)
		expect(server.executions).toHaveLength(1)
		expect(server.deleted).toHaveLength(1)
	} finally {
		caller.abort()
		release.resolve()
		queued.unsubscribe(listener)
	}
})

test('caller cancellation interrupts QueryClient backoff without another callback', async (tc) => {
	using server = await startClientServer({
		async *executeQuery() {
			yield statusPart(Status.OVERLOADED)
		},
	})
	using client = new QueryClient(server.driver)
	let caller = new AbortController()
	let waiting = Promise.withResolvers<void>()
	let callbacks = 0
	let operation = client
		.retrySession(
			{
				signal: caller.signal,
				retry: {
					budget: 3,
					strategy: () => {
						waiting.resolve()
						return 60_000
					},
				},
			},
			async (session) => {
				callbacks++
				await session.execute('SELECT retry')
			}
		)
		.catch((error: unknown) => error)
	await abortable(tc.signal, waiting.promise)
	let reason = new Error('cancelled in backoff')
	caller.abort(reason)
	expect(await abortable(tc.signal, operation)).toBe(reason)
	await abortable(tc.signal, client.close())
	expect(callbacks).toBe(1)
	expect(server.executions).toHaveLength(1)
})

test('one operation timeout covers retries and reaches the active RPC', async (tc) => {
	using timeout = controlledTimeout(1007)
	let entered = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let executions = 0
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			if (++executions === 1) {
				yield statusPart(Status.OVERLOADED)
				return
			}
			entered.resolve()
			await onAbort(context.signal)
			stopped.resolve()
		},
	})
	using client = new QueryClient(server.driver)
	let operation = client
		.retrySession(
			{
				signal: tc.signal,
				timeout: 1007,
				idempotent: true,
				retry: { budget: 3, strategy: 0 },
			},
			(session) => session.execute('SELECT timeout')
		)
		.catch((error: unknown) => error)
	await abortable(tc.signal, entered.promise)
	let reason = new DOMException('operation deadline expired', 'TimeoutError')
	timeout.controller.abort(reason)
	expect(await abortable(tc.signal, operation)).toBe(reason)
	await abortable(tc.signal, stopped.promise)
	await abortable(tc.signal, client.close())
	expect(timeout.calls).toBe(1)
	expect(executions).toBe(2)
})

test('statement timeout cancels its RPC without cancelling the caller or retrying the scope', async (tc) => {
	using timeout = controlledTimeout(1007)
	let entered = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let executions = 0
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			if (++executions > 1) {
				yield resultPart([2])
				return
			}
			entered.resolve()
			await onAbort(context.signal)
			stopped.resolve()
		},
	})
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let callbacks = 0
	let operation = client
		.retrySession(
			{ signal: tc.signal, idempotent: true, retry: { budget: 3, strategy: 0 } },
			async (session) => {
				callbacks++
				await session.execute('SELECT timeout', {}, { timeout: 1007 })
			}
		)
		.catch((error: unknown) => error)
	await abortable(tc.signal, entered.promise)
	let reason = new DOMException('statement deadline expired', 'TimeoutError')
	timeout.controller.abort(reason)
	expect(await abortable(tc.signal, operation)).toMatchObject({ cause: reason })
	await abortable(tc.signal, stopped.promise)
	expect(tc.signal.aborted).toBe(false)
	expect(callbacks).toBe(1)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT fresh')
	)
	expect(result.resultSets[0]!.rows).toEqual([{ id: 2 }])
	expect(server.executions[0]!.sessionId).not.toBe(server.executions[1]!.sessionId)
})

test.for(['raw', 'tagged'] as const)(
	'%s timeout zero is not treated as an absent budget',
	{ timeout: 1000 },
	async (kind, tc) => {
		using server = await startClientServer({
			async *executeQuery(_request, context) {
				await onAbort(context.signal)
				yield resultPart([1])
			},
		})
		using client = new QueryClient(server.driver)
		let operation =
			kind === 'raw'
				? client.retrySession({ signal: tc.signal, timeout: 0 }, (session) =>
						session.execute('SELECT timeout')
					)
				: Promise.resolve(query(client)`SELECT timeout`.timeout(0).signal(tc.signal))
		await expect(operation).rejects.toMatchObject({ name: 'TimeoutError' })
		await abortable(tc.signal, client.close())
	}
)
