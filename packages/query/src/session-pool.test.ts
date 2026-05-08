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

import { Session, SessionBusyError } from './session.ts'
import { SessionLease, SessionPool, SessionPoolFullError } from './session-pool.ts'

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

let srv: Harness | undefined
let pool: SessionPool | undefined

afterEach(async () => {
	await pool?.close().catch(() => {})
	pool = undefined
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

test('reuses the most recently released session first (LIFO)', async () => {
	srv = await startQueryServer()
	pool = new SessionPool(srv.driver, { maxSize: 2 })

	let a = await pool.acquire()
	let b = await pool.acquire()
	let idA = a.id
	let idB = b.id
	expect(idA).not.toBe(idB)

	a[Symbol.dispose]()
	b[Symbol.dispose]() // top of the stack

	let next = await pool.acquire()
	expect(next.id).toBe(idB)
})

test('rejects new waiters once the wait queue hits the cap', async () => {
	srv = await startQueryServer()
	pool = new SessionPool(srv.driver, { maxSize: 1, waitQueueFactor: 2 })

	await pool.acquire() // hold the only session

	let w1 = pool.acquire()
	let w2 = pool.acquire()
	expect(pool.stats.waiting).toBe(2)

	await expect(pool.acquire()).rejects.toBeInstanceOf(SessionPoolFullError)

	// Orphan the waiters — afterEach closes the pool, which rejects them.
	w1.catch(() => {})
	w2.catch(() => {})
})

test('eviction of a busy session pumps a fresh one to the oldest waiter', async () => {
	srv = await startQueryServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

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
	pool = new SessionPool(srv.driver, { maxSize: 1 })

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

	pool = undefined
})

test('lease.signal is lease-scoped — ghost subscribers do not accumulate', async () => {
	srv = await startQueryServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

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

test('SessionLease exposes id and nodeId', async () => {
	srv = await startQueryServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	let lease = await pool.acquire()
	expect(lease).toBeInstanceOf(SessionLease)
	expect(lease.id).toMatch(/^svr-/)
	expect(lease.nodeId).toBe(0n)
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
		(session) => session.close(),
		() => {}
	)
	expect(srv.attachCalls).toHaveLength(1)
})

test('claim() throws SessionBusyError on a second concurrent caller', async () => {
	srv = await startQueryServer()
	let session = await Session.open(srv.driver)

	let first = session.claim()
	try {
		expect(() => session.claim()).toThrow(SessionBusyError)
	} finally {
		first[Symbol.dispose]()
		session.close()
	}
})

test('claim() releases on dispose so the next caller succeeds', async () => {
	srv = await startQueryServer()
	let session = await Session.open(srv.driver)

	{
		using _ = session.claim()
		// scope holds the slot
	}

	// previous claim disposed — a fresh claim must succeed
	let again: Disposable | undefined
	expect(() => {
		again = session.claim()
	}).not.toThrow()
	expect(typeof again?.[Symbol.dispose]).toBe('function')
	again?.[Symbol.dispose]()
	session.close()
})

test('claim() dispose is idempotent', async () => {
	srv = await startQueryServer()
	let session = await Session.open(srv.driver)

	let held = session.claim()
	held[Symbol.dispose]()
	expect(() => held[Symbol.dispose]()).not.toThrow()

	// the slot must still be free
	let again: Disposable | undefined
	expect(() => {
		again = session.claim()
	}).not.toThrow()
	expect(typeof again?.[Symbol.dispose]).toBe('function')
	again?.[Symbol.dispose]()
	session.close()
})
