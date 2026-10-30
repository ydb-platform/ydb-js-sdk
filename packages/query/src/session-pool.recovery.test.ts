import { expect, test } from 'vitest'
import { channel } from 'node:diagnostics_channel'
import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	CreateSessionResponseSchema,
	DeleteSessionResponseSchema,
	QueryServiceDefinition,
	SessionStateSchema,
} from '@ydbjs/api/query'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { Server } from '@ydbjs/grpc'

import { SessionPool, SessionPoolFullError, type SessionPoolOptions } from './session-pool.ts'

type CreateRequest = {
	signal: AbortSignal
	cancelled: Promise<void>
	resolve: (status: StatusIds_StatusCode) => void
}

// CreateSession responses are gated to reproduce queue and cancellation races.
async function startQueryServer() {
	let requests: CreateRequest[] = []
	let waiting: ((request: CreateRequest) => void) | undefined
	let createCount = 0
	let deleteCount = 0
	let server = new Server()
	server.add(QueryServiceDefinition, {
		async createSession(_request, ctx) {
			let id = ++createCount
			let response = Promise.withResolvers<StatusIds_StatusCode>()
			let cancelled = new Promise<void>((resolve) => {
				if (ctx.signal.aborted) resolve()
				else ctx.signal.addEventListener('abort', () => resolve(), { once: true })
			})
			let request = { signal: ctx.signal, cancelled, resolve: response.resolve }
			if (waiting) {
				let resolve = waiting
				waiting = undefined
				resolve(request)
			} else {
				requests.push(request)
			}
			let status = await abortable(ctx.signal, response.promise)
			return create(CreateSessionResponseSchema, {
				status,
				sessionId: `recovery-${id}`,
				nodeId: 0n,
			})
		},
		async *attachSession(_request, ctx) {
			yield create(SessionStateSchema, { status: StatusIds_StatusCode.SUCCESS })
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve()
				ctx.signal.addEventListener('abort', () => resolve(), { once: true })
			})
		},
		async deleteSession() {
			deleteCount++
			return create(DeleteSessionResponseSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	return {
		driver,
		get createCount() {
			return createCount
		},
		get deleteCount() {
			return deleteCount
		},
		nextCreate(signal: AbortSignal): Promise<CreateRequest> {
			let request = requests.shift()
			if (request) return Promise.resolve(request)
			let next = Promise.withResolvers<CreateRequest>()
			waiting = next.resolve
			return abortable(signal, next.promise)
		},
		[Symbol.dispose]() {
			driver.close()
			server[Symbol.dispose]()
		},
	}
}

test('a failed session creation gives queued acquisition the freed capacity', async (tc) => {
	using server = await startQueryServer()
	await using pool = new SessionPool(server.driver, { maxSize: 1 })
	let first = pool.acquire(tc.signal).catch((error: unknown) => error)
	let createRequest = await server.nextCreate(tc.signal)
	let second = pool.acquire(tc.signal)
	expect(pool.stats.waiting).toBe(1)
	createRequest.resolve(StatusIds_StatusCode.OVERLOADED)
	await expect(first).resolves.toBeInstanceOf(YDBError)
	let replacement = await server.nextCreate(tc.signal)
	replacement.resolve(StatusIds_StatusCode.SUCCESS)
	using lease = await second
	expect(lease.id).toBe('recovery-2')
	expect(pool.stats).toMatchObject({ total: 1, creating: 0, waiting: 0 })
})

test('a failed warm-up does not strand a queued acquisition', async (tc) => {
	using server = await startQueryServer()
	await using pool = new SessionPool(server.driver, { maxSize: 1, minSize: 1 })
	let warmup = await server.nextCreate(tc.signal)
	let acquiring = pool.acquire(tc.signal)
	warmup.resolve(StatusIds_StatusCode.OVERLOADED)
	let replacement = await server.nextCreate(tc.signal)
	replacement.resolve(StatusIds_StatusCode.SUCCESS)
	using lease = await acquiring
	expect(lease.id).toBe('recovery-2')
	expect(pool.stats).toMatchObject({ total: 1, idle: 0, waiting: 0 })
})

test('cancelling a dequeued acquisition cancels its create and serves the next waiter', async (tc) => {
	using server = await startQueryServer()
	await using pool = new SessionPool(server.driver, { maxSize: 1 })
	let initial = pool.acquire(tc.signal).catch((error: unknown) => error)
	let creation = await server.nextCreate(tc.signal)
	let caller = new AbortController()
	let cancelled = pool.acquire(caller.signal).catch((error: unknown) => error)
	let reason = new Error('cancelled acquisition')
	let next = pool.acquire(tc.signal)
	void next.catch(() => {})
	creation.resolve(StatusIds_StatusCode.OVERLOADED)
	await expect(initial).resolves.toBeInstanceOf(YDBError)
	let cancelledCreation = await server.nextCreate(tc.signal)
	caller.abort(reason)
	await expect(cancelled).resolves.toBe(reason)
	let replacement = await server.nextCreate(tc.signal)
	await abortable(tc.signal, cancelledCreation.cancelled)
	expect(cancelledCreation.signal.aborted).toBe(true)
	replacement.resolve(StatusIds_StatusCode.SUCCESS)
	using lease = await next
	expect(lease.id).toBe('recovery-3')
	expect(pool.stats).toMatchObject({ total: 1, creating: 0, waiting: 0 })
})

test('disposing a lease twice cannot lend its session to two callers', async (tc) => {
	using server = await startQueryServer()
	await using pool = new SessionPool(server.driver, { maxSize: 1 })
	let initial = pool.acquire(tc.signal)
	let creation = await server.nextCreate(tc.signal)
	creation.resolve(StatusIds_StatusCode.SUCCESS)
	let lease = await initial
	lease[Symbol.dispose]()
	lease[Symbol.dispose]()
	using next = await pool.acquire(tc.signal)
	let waiting = pool.acquire(tc.signal)
	expect(pool.stats).toMatchObject({ total: 1, idle: 0, waiting: 1 })
	next[Symbol.dispose]()
	using handedOff = await waiting
	expect(handedOff.id).toBe(lease.id)
	expect(server.createCount).toBe(1)
})

test('cancellation during session handoff leaves it available to another waiter', async (tc) => {
	using server = await startQueryServer()
	await using pool = new SessionPool(server.driver, { maxSize: 1 })
	let initial = pool.acquire(tc.signal)
	let creation = await server.nextCreate(tc.signal)
	creation.resolve(StatusIds_StatusCode.SUCCESS)
	let lease = await initial
	let caller = new AbortController()
	let cancelled = pool.acquire(caller.signal).catch((error: unknown) => error)
	let reason = new Error('cancelled handoff')
	let next = pool.acquire(tc.signal)
	let releases = 0
	let events = channel('ydb:query.session.released')
	let listener = () => releases++
	events.subscribe(listener)
	try {
		lease[Symbol.dispose]()
		caller.abort(reason)
		await expect(cancelled).resolves.toBe(reason)
		using replacement = await next
		expect(replacement.id).toBe(lease.id)
		expect(pool.stats).toMatchObject({ total: 1, idle: 0, waiting: 0 })
		expect(releases).toBe(1)
	} finally {
		events.unsubscribe(listener)
	}
})

test('invalidating a session evicts it once and replaces it for waiting work', async (tc) => {
	using server = await startQueryServer()
	await using pool = new SessionPool(server.driver, { maxSize: 1 })
	let initial = pool.acquire(tc.signal)
	let creation = await server.nextCreate(tc.signal)
	creation.resolve(StatusIds_StatusCode.SUCCESS)
	using lease = await initial
	let closed: unknown[] = []
	let events = channel('ydb:query.session.closed')
	let listener = (event: unknown) => closed.push(event)
	events.subscribe(listener)
	try {
		let waiting = pool.acquire(tc.signal)
		lease.session.invalidate()
		lease.session.invalidate()
		expect(lease.signal.aborted).toBe(true)
		expect(() => lease.session.claim()).toThrow('aborted: invalidated')
		let replacement = await server.nextCreate(tc.signal)
		replacement.resolve(StatusIds_StatusCode.SUCCESS)
		using next = await waiting
		expect(next.id).not.toBe(lease.id)
		expect(closed).toHaveLength(1)
		expect(closed[0]).toMatchObject({ sessionId: lease.id, reason: 'invalidated' })
		expect(server.deleteCount).toBe(0)
	} finally {
		events.unsubscribe(listener)
	}
})

test('a zero wait queue factor permits immediate acquisition but rejects waiting', async (tc) => {
	using server = await startQueryServer()
	await using pool = new SessionPool(server.driver, { maxSize: 1, waitQueueFactor: 0 })
	let initial = pool.acquire(tc.signal)
	let creation = await server.nextCreate(tc.signal)
	creation.resolve(StatusIds_StatusCode.SUCCESS)
	using lease = await initial
	expect(lease.session.alive).toBe(true)
	await expect(pool.acquire(tc.signal)).rejects.toBeInstanceOf(SessionPoolFullError)
	expect(pool.stats).toMatchObject({ total: 1, waiting: 0 })
})

test.each([
	{ maxSize: 0 },
	{ maxSize: -1 },
	{ maxSize: 0.5 },
	{ maxSize: Number.NaN },
	{ maxSize: Number.POSITIVE_INFINITY },
	{ minSize: -1 },
	{ minSize: 0.5 },
	{ minSize: Number.NaN },
	{ minSize: Number.POSITIVE_INFINITY },
	{ waitQueueFactor: -1 },
	{ waitQueueFactor: Number.NaN },
	{ waitQueueFactor: Number.POSITIVE_INFINITY },
	{ maxSize: Number.MAX_SAFE_INTEGER, waitQueueFactor: 2 },
] satisfies SessionPoolOptions[])(
	'rejects invalid pool bounds before creating sessions: %j',
	(options) => {
		using driver = new Driver('grpc://localhost:2136/local', {
			'ydb.sdk.enable_discovery': false,
		})
		expect(() => new SessionPool(driver, options)).toThrow(RangeError)
	}
)
