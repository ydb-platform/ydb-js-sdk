import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import {
	CoordinationClient,
	type CoordinationSession,
	LeaseReleasedError,
	SessionClosedError,
} from '@ydbjs/coordination'

declare module 'vitest' {
	export interface ProvidedContext {
		connectionString: string
	}
}

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})

await driver.ready()

let client = new CoordinationClient(driver)

let testNodePath: string
let session: CoordinationSession

beforeEach(async (ctx) => {
	let suffix = `${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`
	testNodePath = `/local/test-coord-session-${suffix}`

	await client.createNode(testNodePath, {}, ctx.signal)
	session = await client.createSession(testNodePath, {}, ctx.signal)

	onTestFinished(async () => {
		session.destroy()
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})

// ── Session lifecycle ────────────────────────────────────────────────────────

test('session is ready after createSession', () => {
	expect(session.status).toBe('ready')
	expect(session.sessionId).not.toBeNull()
	expect(session.signal.aborted).toBe(false)
})

test('close transitions to closed and aborts signal', async (tc) => {
	await session.close(tc.signal)

	expect(session.status).toBe('closed')
	expect(session.signal.aborted).toBe(true)
	expect(session.signal.reason).toBeInstanceOf(SessionClosedError)
})

test('destroy transitions to closed and aborts signal with reason', async () => {
	let reason = new Error('test destroy')
	session.destroy(reason)

	// Give FSM time to finalize
	await new Promise((r) => setTimeout(r, 100))

	expect(session.status).toBe('closed')
	expect(session.signal.aborted).toBe(true)
	expect(session.signal.reason).toBe(reason)
})

test('session.signal stays alive while session is ready', () => {
	expect(session.signal.aborted).toBe(false)
})

// ── Lease signal ─────────────────────────────────────────────────────────────

test('lease.signal aborts with LeaseReleasedError after release', async (tc) => {
	let sem = session.semaphore(`sem-${Date.now()}`)

	await sem.create({ limit: 1 }, tc.signal)
	let lease = await sem.acquire({ count: 1 }, tc.signal)

	expect(lease.signal.aborted).toBe(false)

	await lease.release(tc.signal)

	expect(lease.signal.aborted).toBe(true)
	expect(lease.signal.reason).toBeInstanceOf(LeaseReleasedError)
})

test('lease.signal is independent from session.signal', async (tc) => {
	let sem = session.semaphore(`sem-${Date.now()}`)

	await sem.create({ limit: 1 }, tc.signal)
	let lease = await sem.acquire({ count: 1 }, tc.signal)

	session.destroy()
	await new Promise((r) => setTimeout(r, 100))

	// Session is dead, but lease.signal is its own AC — not linked
	expect(session.signal.aborted).toBe(true)
	expect(lease.signal.aborted).toBe(false)
})

test('double release is idempotent', async (tc) => {
	let sem = session.semaphore(`sem-${Date.now()}`)

	await sem.create({ limit: 1 }, tc.signal)
	let lease = await sem.acquire({ count: 1 }, tc.signal)

	await lease.release(tc.signal)
	// Second release should not throw
	await expect(lease.release(tc.signal)).resolves.toBeUndefined()
})

// ── User signal cancellation ─────────────────────────────────────────────────

test('user signal cancels pending acquire without killing session', async (tc) => {
	let name = `sem-${Date.now()}`

	let semA = session.semaphore(name)
	await semA.create({ limit: 1 }, tc.signal)

	// Session A fills the semaphore
	let lease = await semA.acquire({ count: 1 }, tc.signal)

	// Session B tries to acquire — will block because A holds the only token
	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	let semB = sessionB.semaphore(name)

	let userAC = new AbortController()
	let acquirePromise = semB.acquire({ count: 1, waitTimeout: 30000 }, userAC.signal)

	// Cancel after a short delay
	setTimeout(() => userAC.abort(new Error('user cancelled')), 200)

	await expect(acquirePromise).rejects.toBeDefined()

	// Both sessions still alive
	expect(session.status).toBe('ready')
	expect(sessionB.status).toBe('ready')

	await lease.release(tc.signal)
})
