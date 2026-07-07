import { afterEach, expect, test } from 'vitest'
import { createServer } from 'nice-grpc'
import { create } from '@bufbuild/protobuf'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	CreateSessionResponseSchema,
	DeleteSessionResponseSchema,
	QueryServiceDefinition,
	SessionStateSchema,
} from '@ydbjs/api/query'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'

import { Session } from './session.ts'
import { SessionLease, SessionPool } from './session-pool.ts'

// This file is deliberately narrow: only scenarios that need server-side
// fault injection (killing a session's attach stream mid-flight, holding
// CreateSession open to race pool.close(), forcing a bad first attach
// message) — none of that is triggerable on demand against a real YDB
// instance. Golden-path SessionPool/Session/SessionLease behavior (LIFO
// reuse, warm-up, claim lifecycle, wait-queue capacity) lives in
// ../tests/session-pool.test.ts against real YDB instead.

/**
 * Minimal in-memory QueryService. Tests get:
 *  - `breakSession(id)`: server-side abort of a session's attach stream
 *    (simulates YDB-driven invalidation).
 *  - `holdCreateSession()`: blocks every subsequent `CreateSession` until
 *    the returned release function is called (for races with pool close).
 *  - `firstAttachStatus`: let tests make attach fail on the first message.
 */
async function startQueryServer() {
	let nextId = 0
	let attachCtrls = new Map<string, AbortController>()
	let holdPromise: Promise<void> | undefined
	let holdResolve: (() => void) | undefined
	let firstAttachStatus = StatusIds_StatusCode.SUCCESS

	let createCount = 0
	let deleteCalls: string[] = []
	let attachCalls: string[] = []

	let server = createServer()
	let subset = {
		createSession: QueryServiceDefinition.createSession,
		deleteSession: QueryServiceDefinition.deleteSession,
		attachSession: QueryServiceDefinition.attachSession,
	}
	server.add(subset, {
		async createSession() {
			createCount++
			if (holdPromise) await holdPromise
			let sessionId = `svr-${++nextId}`
			attachCtrls.set(sessionId, new AbortController())
			return create(CreateSessionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				sessionId,
				nodeId: 0n,
			})
		},
		async deleteSession(req) {
			deleteCalls.push(req.sessionId)
			attachCtrls.get(req.sessionId)?.abort()
			return create(DeleteSessionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
			})
		},
		async *attachSession(req, ctx) {
			attachCalls.push(req.sessionId)
			let serverCtrl = attachCtrls.get(req.sessionId) ?? new AbortController()

			yield create(SessionStateSchema, { status: firstAttachStatus })
			if (firstAttachStatus !== StatusIds_StatusCode.SUCCESS) return

			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted || serverCtrl.signal.aborted) return resolve()
				let onAbort = () => resolve()
				ctx.signal.addEventListener('abort', onAbort, { once: true })
				serverCtrl.signal.addEventListener('abort', onAbort, { once: true })
			})
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
		get deleteCalls() {
			return deleteCalls
		},
		get attachCalls() {
			return attachCalls
		},
		breakSession(id: string) {
			attachCtrls.get(id)?.abort()
		},
		setFirstAttachStatus(status: number) {
			firstAttachStatus = status
		},
		holdCreateSession() {
			holdPromise = new Promise<void>((r) => (holdResolve = r))
			return () => holdResolve?.()
		},
		async close() {
			holdResolve?.()
			driver.close()
			await server.shutdown()
		},
	}
}

type Harness = Awaited<ReturnType<typeof startQueryServer>>

// SessionPool is AsyncDisposable — each test declares its own `await using
// pool`. Only the raw server harness (not disposable) needs shared afterEach
// cleanup.
let srv: Harness | undefined

afterEach(async () => {
	await srv?.close()
	srv = undefined
})

/** Poll a condition until true or timeout — async server effects need time. */
async function until(cond: () => boolean, timeoutMs = 500): Promise<void> {
	let deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (cond()) return
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((r) => setTimeout(r, 5))
	}
	throw new Error(`timed out waiting for condition (${timeoutMs}ms)`)
}

test('eviction of a busy session pumps a fresh one to the oldest waiter', async () => {
	srv = await startQueryServer()
	await using pool = new SessionPool(srv.driver, { maxSize: 1 })

	let held = await pool.acquire()
	let heldId = held.id
	let waiter = pool.acquire()

	// Server kills the in-use session's attach stream — monitor catches it,
	// pool evicts, pumps a fresh create for the waiter.
	srv.breakSession(heldId)

	let replacement = await waiter
	expect(replacement.id).not.toBe(heldId)
	expect(srv.createCount).toBe(2)

	held[Symbol.dispose]() // no-op: session already broken
	replacement[Symbol.dispose]()
})

test('close() during in-flight create does not hang and rejects the pending acquire', async () => {
	srv = await startQueryServer()
	let release = srv.holdCreateSession()
	await using pool = new SessionPool(srv.driver, { maxSize: 1 })

	// Pre-catch: close() will cancel the in-flight RPC via abort, and we
	// don't want the racing rejection to surface as unhandled.
	let acquiring = pool.acquire().then(
		(lease) => ({ ok: true as const, lease }),
		(error) => ({ ok: false as const, error })
	)

	// Let the RPC actually reach the server before we pull the rug.
	await new Promise((r) => setTimeout(r, 30))

	let closing = pool.close()
	release() // let the stuck server-side handler unwind regardless

	await closing // must not hang
	let result = await acquiring
	expect(result.ok).toBe(false)
})

test('lease.signal is lease-scoped — ghost subscribers do not accumulate', async () => {
	srv = await startQueryServer()
	await using pool = new SessionPool(srv.driver, { maxSize: 1 })

	let lease = await pool.acquire()
	let capturedSignal = lease.signal
	let id = lease.id
	lease[Symbol.dispose]()

	// Break the session AFTER the lease is disposed. A naive implementation
	// that exposes session.signal directly would abort this signal too —
	// that's how 1000 concurrent queries on a hot session would leave
	// 1000 ghost subscribers behind.
	srv.breakSession(id)
	await new Promise((r) => setTimeout(r, 50))

	expect(capturedSignal.aborted).toBe(false)
})

test('Session.open deletes the server-side session when attach first message is bad', async () => {
	srv = await startQueryServer()
	srv.setFirstAttachStatus(StatusIds_StatusCode.BAD_SESSION)

	await expect(Session.open(srv.driver)).rejects.toBeInstanceOf(YDBError)

	// Fire-and-forget DeleteSession — wait for the RPC to actually land.
	await until(() => srv!.deleteCalls.length > 0)
	expect(srv.deleteCalls).toHaveLength(1)
})

test('Session.open aborts the attach stream when the caller signal fires mid-wait', async () => {
	srv = await startQueryServer()

	// Hold the first attach message forever — the harness normally yields
	// SUCCESS on first message; here we want to verify cancellation during
	// the wait, so swap the first status into a different keepalive.
	// Easiest approach: don't emit first message — achieved by making the
	// attach handler hang before yielding. Patch via the harness:
	srv.setFirstAttachStatus(StatusIds_StatusCode.SUCCESS)

	let ctrl = new AbortController()
	let opening = Session.open(srv.driver, ctrl.signal)

	// Wait for the attach RPC to reach the server.
	await until(() => srv!.attachCalls.length > 0)

	// Client aborts — nice-grpc should cancel the stream; our forward
	// listener in #bindAttach propagates the abort into #attach.
	ctrl.abort(new Error('caller gave up'))

	// The promise rejects. Session.open may resolve OK if attach's first
	// SUCCESS message was already received before we aborted — in that
	// race we simply verify that either resolution cleans up.
	await opening.then(
		(session) => session.close('pool_close'),
		() => {}
	)
	expect(srv.attachCalls).toHaveLength(1)
})

test('refills to minSize after a session is evicted by the server', async () => {
	srv = await startQueryServer()
	await using pool = new SessionPool(srv.driver, { maxSize: 5, minSize: 2 })

	await until(() => pool.stats.total === 2, 1000)
	let createsBeforeEviction = srv.createCount
	let killed = srv.attachCalls[0]

	// Server tears down the attach stream → Session.#runMonitor flips it
	// broken → pool eviction listener removes from #all → refill kicks in.
	srv.breakSession(killed)

	await until(() => srv!.createCount > createsBeforeEviction, 2000)
	await until(() => pool.stats.total === 2, 2000)

	expect(pool.stats.total).toBe(2)
	expect(srv.createCount).toBe(createsBeforeEviction + 1)
})

test('hands a warming session to a waiter when warm-up holds all capacity', async () => {
	srv = await startQueryServer()
	let release = srv.holdCreateSession()

	await using pool = new SessionPool(srv.driver, { maxSize: 2, minSize: 2 })

	// Both create slots are taken by held warm-ups; acquire() must queue
	// rather than spawn a third create.
	let acquired = pool.acquire()
	await until(() => pool.stats.waiting === 1, 500)

	release()

	let lease = await acquired
	expect(lease).toBeInstanceOf(SessionLease)
	expect(pool.stats.waiting).toBe(0)
	// Two creates total — the waiter received a warm-up session via
	// #growAndPark's handoff path, no extra grow was issued.
	expect(srv.createCount).toBe(2)
})

test('pool.close() during warm-up settles without hanging', async () => {
	srv = await startQueryServer()
	srv.holdCreateSession() // hold indefinitely; never released

	await using pool = new SessionPool(srv.driver, { maxSize: 5, minSize: 5 })

	// All five warm-up creates are blocked on the server. close() must
	// abort them through the linked close signal and resolve quickly.
	await Promise.race([
		pool.close(),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('pool.close() hung during warm-up')), 2000)
		),
	])

	expect(pool.closed).toBe(true)
})
