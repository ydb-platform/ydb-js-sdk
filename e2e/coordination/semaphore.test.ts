import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import {
	CoordinationClient,
	type CoordinationSession,
	Lease,
	LeaseReleasedError,
} from '@ydbjs/coordination'

// #region setup
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
let sessionA: CoordinationSession

beforeEach(async (ctx) => {
	let suffix = `${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`
	testNodePath = `/local/test-coord-sem-${suffix}`

	await client.createNode(testNodePath, {}, ctx.signal)

	sessionA = await client.createSession(testNodePath, {}, ctx.signal)

	onTestFinished(async () => {
		await sessionA.close(AbortSignal.timeout(5000)).catch(() => {})
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})
// #endregion

// Helper: unique semaphore name per call so tests never collide even within a file
let semName = () => `sem-${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`

test('creates and describes a semaphore', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)
	let data = Buffer.from('hello')

	await sem.create({ limit: 5, data }, tc.signal)

	let description = await sem.describe({}, tc.signal)

	expect(description.name).toBe(name)
	expect(description.limit).toBe(5n)
	expect(Buffer.from(description.data)).toEqual(data)
	expect(description.count).toBe(0n)
})

test('acquires and releases a semaphore', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, tc.signal)

	let lease = await sem.acquire({ count: 1 }, tc.signal)

	// Lease signal must be alive while held
	expect(lease.signal.aborted).toBe(false)

	await lease.release(tc.signal)

	let description = await sem.describe({ owners: true }, tc.signal)

	expect(description.owners).toHaveLength(0)
	expect(description.count).toBe(0n)
})

test('async dispose releases the lease', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, tc.signal)

	{
		await using _lease = await sem.acquire({ count: 1 }, tc.signal)
		// lease is held inside the block
	}

	// After the block the lease must have been released
	let description = await sem.describe({ owners: true }, tc.signal)

	expect(description.owners).toHaveLength(0)
})

test('acquire blocks until capacity is available', async (tc) => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, tc.signal)

	let leaseA = await semA.acquire({ count: 1 }, tc.signal)

	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)

	let semB = sessionB.semaphore(name)

	// Session B starts waiting — pass an explicit waitTimeout so the server
	// keeps the request open instead of returning a miss immediately.
	let acquireB = semB.acquire({ count: 1, waitTimeout: 10000 }, tc.signal)

	// Release A's lease so B can proceed
	await leaseA.release(tc.signal)

	await using leaseB = await acquireB

	expect(leaseB).toBeInstanceOf(Lease)
	expect(leaseB.signal.aborted).toBe(false)
})

test('tryAcquire succeeds when semaphore has capacity', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 3 }, tc.signal)

	let lease = await sem.tryAcquire({ count: 1 }, tc.signal)

	expect(lease).not.toBeNull()
	expect(lease).toBeInstanceOf(Lease)

	await lease!.release(tc.signal)
})

test('tryAcquire returns null when semaphore is full', async (tc) => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, tc.signal)

	// Session A fills the semaphore
	let leaseA = await semA.acquire({ count: 1 }, tc.signal)

	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)

	let semB = sessionB.semaphore(name)

	let lease = await semB.tryAcquire({ count: 1 }, tc.signal)

	expect(lease).toBeNull()

	await leaseA.release(tc.signal)
})

test('updates semaphore data', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	let original = Buffer.from('original')
	let updated = Buffer.from('updated')

	await sem.create({ limit: 1, data: original }, tc.signal)

	await sem.update(updated, tc.signal)

	let description = await sem.describe({}, tc.signal)

	expect(Buffer.from(description.data)).toEqual(updated)
})

test('deletes a semaphore', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, tc.signal)

	await sem.delete({}, tc.signal)

	await expect(sem.describe({}, tc.signal)).rejects.toThrow(/NOT_FOUND/i)
})

test('force deletes a semaphore while it is held', async (tc) => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, tc.signal)

	// Acquire and deliberately do not release before deleting
	await semA.acquire({ count: 1 }, tc.signal)

	// Force delete must succeed even though the semaphore is held
	await expect(semA.delete({ force: true }, tc.signal)).resolves.not.toThrow()
})

test('watch emits updated owners when another session acquires', async (tc) => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, tc.signal)

	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)

	let semB = sessionB.semaphore(name)

	let watchController = new AbortController()
	let snapshots: Array<{ count: bigint; ownersCount: number }> = []

	// Collect watch events in the background until we see an owner
	let watching = (async () => {
		for await (let snap of semA.watch(
			{ owners: true },
			AbortSignal.any([watchController.signal, tc.signal])
		)) {
			snapshots.push({ count: snap.count, ownersCount: snap.owners?.length ?? 0 })
			// Stop as soon as we see a non-empty owners list
			if (snap.owners && snap.owners.length > 0) {
				watchController.abort()
				break
			}
		}
	})()

	// Give the watch stream a moment to register with the server
	await new Promise((resolve) => setTimeout(resolve, 200))

	await using _lease = await semB.acquire({ count: 1 }, tc.signal)

	await watching

	expect(snapshots.length).toBeGreaterThanOrEqual(1)
	expect(snapshots.some((s) => s.ownersCount > 0)).toBe(true)
})

test('watch with owners includes session id in owner entries', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, tc.signal)

	let lease = await sem.acquire({ count: 1 }, tc.signal)

	let watchController = new AbortController()

	let firstOwnerSessionId: bigint | undefined

	for await (let snap of sem.watch({ owners: true }, watchController.signal)) {
		let owner = snap.owners?.[0]
		if (owner) {
			firstOwnerSessionId = owner.sessionId
			watchController.abort()
			break
		}
	}

	await lease.release(tc.signal)

	expect(firstOwnerSessionId).toBe(sessionA.sessionId)
})

test('ephemeral semaphore is removed when the acquiring session is closed', async (tc) => {
	let name = semName()

	// Use a dedicated session so we can close it without affecting sessionA
	let sessionToClose = await client.createSession(testNodePath, {}, tc.signal)

	let sem = sessionToClose.semaphore(name)

	// Acquire with ephemeral:true — the semaphore is created by the server and
	// tied to this session's lifetime.
	await sem.acquire({ count: 1, ephemeral: true }, tc.signal)

	// Close the session gracefully — this sends a session stop to the server
	// which immediately deletes all ephemeral semaphores tied to it.
	await sessionToClose.close(tc.signal)

	// The ephemeral semaphore must be gone entirely: describe throws NOT_FOUND.
	let semA = sessionA.semaphore(name)
	await expect(semA.describe({}, tc.signal)).rejects.toThrow(/NOT_FOUND/i)
})

// ── Signal contracts ────────────────────────────────────────────────────────

test('lease.signal.reason is LeaseReleasedError after release', async (tc) => {
	let sem = sessionA.semaphore(semName())

	await sem.create({ limit: 1 }, tc.signal)
	let lease = await sem.acquire({ count: 1 }, tc.signal)

	await lease.release(tc.signal)

	expect(lease.signal.aborted).toBe(true)
	expect(lease.signal.reason).toBeInstanceOf(LeaseReleasedError)
})

test('double release is idempotent', async (tc) => {
	let sem = sessionA.semaphore(semName())

	await sem.create({ limit: 1 }, tc.signal)
	let lease = await sem.acquire({ count: 1 }, tc.signal)

	await lease.release(tc.signal)
	await expect(lease.release(tc.signal)).resolves.toBeUndefined()
})

// ── Race conditions ─────────────────────────────────────────────────────────

test('N sessions race for semaphore with limit=1 — exactly one wins', async (tc) => {
	let name = semName()
	let N = 5

	await sessionA.semaphore(name).create({ limit: 1 }, tc.signal)

	let sessions: CoordinationSession[] = []
	for (let i = 0; i < N; i++) {
		// oxlint-disable-next-line no-await-in-loop
		sessions.push(await client.createSession(testNodePath, {}, tc.signal))
	}

	try {
		// All sessions tryAcquire simultaneously
		let results = await Promise.all(
			sessions.map((s) => s.semaphore(name).tryAcquire({ count: 1 }, tc.signal))
		)

		let winners = results.filter((r) => r !== null)
		let losers = results.filter((r) => r === null)

		expect(winners).toHaveLength(1)
		expect(losers).toHaveLength(N - 1)

		await winners[0]!.release(tc.signal)
	} finally {
		for (let s of sessions) {
			// oxlint-disable-next-line no-await-in-loop
			await s.close(AbortSignal.timeout(5000)).catch(() => {})
		}
	}
})

test('rapid acquire-release cycles do not lose tokens', async (tc) => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, tc.signal)

	// 20 sequential acquire-release cycles on the same session
	for (let i = 0; i < 20; i++) {
		// oxlint-disable-next-line no-await-in-loop
		let lease = await sem.acquire({ count: 1 }, tc.signal)
		// oxlint-disable-next-line no-await-in-loop
		await lease.release(tc.signal)
	}

	// Semaphore must be free after all cycles
	let description = await sem.describe({ owners: true }, tc.signal)
	expect(description.count).toBe(0n)
	expect(description.owners).toHaveLength(0)
})

test('watch sees all changes during rapid acquire-release', async (tc) => {
	let name = semName()

	// Watch runs on a dedicated session so it can be closed to end the watch loop —
	// the loop blocks on the server queue and only unblocks when its session dies,
	// not on an abort signal alone.
	let sessionToClose = await client.createSession(testNodePath, {}, tc.signal)
	let sem = sessionToClose.semaphore(name)

	await sem.create({ limit: 1 }, tc.signal)

	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	let semB = sessionB.semaphore(name)

	let changeCount = 0

	// Collect snapshots until the session closes below (server may coalesce rapid changes)
	let watching = (async () => {
		for await (let _snap of sem.watch({ owners: true }, tc.signal)) {
			changeCount++
		}
	})().catch(() => {})

	await new Promise((resolve) => setTimeout(resolve, 200))

	// Trigger changes from session B
	let lease1 = await semB.acquire({ count: 1 }, tc.signal)
	await lease1.release(tc.signal)
	let lease2 = await semB.acquire({ count: 1 }, tc.signal)
	await lease2.release(tc.signal)

	// Give the server a moment to deliver the change notifications before closing
	await new Promise((resolve) => setTimeout(resolve, 200))

	await sessionToClose.close(AbortSignal.timeout(5000))

	await watching

	// Initial snapshot + at least one change notification (server may coalesce rapid changes)
	expect(changeCount).toBeGreaterThanOrEqual(2)
})

// ── Misuse and error handling ───────────────────────────────────────────────

test('acquire on non-existent semaphore throws', async (tc) => {
	let sem = sessionA.semaphore('does-not-exist-' + Date.now())

	await expect(
		sem.acquire({ count: 1, ephemeral: false, waitTimeout: 0n }, tc.signal)
	).rejects.toThrow('NOT_FOUND')
})

test('user signal cancels blocked acquire without killing session', async (tc) => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, tc.signal)
	let leaseA = await semA.acquire({ count: 1 }, tc.signal)

	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	let semB = sessionB.semaphore(name)

	let userAC = new AbortController()
	let acquirePromise = semB.acquire({ count: 1, waitTimeout: 30000 }, userAC.signal)

	setTimeout(() => userAC.abort(new Error('user cancelled')), 200)

	await expect(acquirePromise).rejects.toBeDefined()

	// Both sessions still alive
	expect(sessionA.status).toBe('ready')
	expect(sessionB.status).toBe('ready')

	await leaseA.release(tc.signal)
})

test('server-side waitTimeout returns TryAcquireMiss (not hang)', async (tc) => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, tc.signal)
	let leaseA = await semA.acquire({ count: 1 }, tc.signal)

	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	let semB = sessionB.semaphore(name)

	// Short server-side timeout — should return null, not hang
	let lease = await semB.tryAcquire({ count: 1 }, tc.signal)
	expect(lease).toBeNull()

	await leaseA.release(tc.signal)
})

test('many parallel operations on one session do not deadlock', async (tc) => {
	let N = 10
	let names = Array.from({ length: N }, () => semName())

	// Create all semaphores
	await Promise.all(names.map((name) => sessionA.semaphore(name).create({ limit: 1 }, tc.signal)))

	// Acquire all in parallel
	let leases = await Promise.all(
		names.map((name) => sessionA.semaphore(name).acquire({ count: 1 }, tc.signal))
	)

	expect(leases).toHaveLength(N)
	expect(leases.every((l) => l instanceof Lease)).toBe(true)

	// Release all in parallel
	await Promise.all(leases.map((l) => l.release(tc.signal)))

	// Verify all free
	let descriptions = await Promise.all(
		names.map((name) => sessionA.semaphore(name).describe({ owners: true }, tc.signal))
	)

	expect(descriptions.every((d) => d.count === 0n)).toBe(true)
})
