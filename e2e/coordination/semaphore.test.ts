import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient, type CoordinationSession, Lease } from '@ydbjs/coordination'

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

beforeEach(async () => {
	let suffix = `${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`
	testNodePath = `/local/test-coord-sem-${suffix}`

	await client.createNode(testNodePath, {}, AbortSignal.timeout(5000))

	sessionA = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	onTestFinished(async () => {
		await sessionA.close(AbortSignal.timeout(5000)).catch(() => {})
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})
// #endregion

// Helper: unique semaphore name per call so tests never collide even within a file
let semName = () => `sem-${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`

test('creates and describes a semaphore', async () => {
	let name = semName()
	let sem = sessionA.semaphore(name)
	let data = Buffer.from('hello')

	await sem.create({ limit: 5, data }, AbortSignal.timeout(5000))

	let description = await sem.describe({}, AbortSignal.timeout(5000))

	expect(description.name).toBe(name)
	expect(description.limit).toBe(5n)
	expect(Buffer.from(description.data)).toEqual(data)
	expect(description.count).toBe(0n)
})

test('acquires and releases a semaphore', async () => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, AbortSignal.timeout(5000))

	let lease = await sem.acquire({ count: 1 }, AbortSignal.timeout(5000))

	// Lease signal must be alive while held
	expect(lease.signal.aborted).toBe(false)

	await lease.release(AbortSignal.timeout(5000))

	let description = await sem.describe({ owners: true }, AbortSignal.timeout(5000))

	expect(description.owners).toHaveLength(0)
	expect(description.count).toBe(0n)
})

test('async dispose releases the lease', async () => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, AbortSignal.timeout(5000))

	{
		await using _lease = await sem.acquire({ count: 1 }, AbortSignal.timeout(5000))
		// lease is held inside the block
	}

	// After the block the lease must have been released
	let description = await sem.describe({ owners: true }, AbortSignal.timeout(5000))

	expect(description.owners).toHaveLength(0)
})

test('acquire blocks until capacity is available', async () => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, AbortSignal.timeout(5000))

	// Session A holds the only token
	let leaseA = await semA.acquire({ count: 1 }, AbortSignal.timeout(5000))

	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let semB = sessionB.semaphore(name)

	// Session B starts waiting — pass an explicit waitTimeout so the server
	// keeps the request open instead of returning a miss immediately.
	let acquireB = semB.acquire({ count: 1, waitTimeout: 10000 }, AbortSignal.timeout(10000))

	// Release A's lease so B can proceed
	await leaseA.release(AbortSignal.timeout(5000))

	await using leaseB = await acquireB

	expect(leaseB).toBeInstanceOf(Lease)
	expect(leaseB.signal.aborted).toBe(false)
})

test('tryAcquire succeeds when semaphore has capacity', async () => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 3 }, AbortSignal.timeout(5000))

	let lease = await sem.tryAcquire({ count: 1 }, AbortSignal.timeout(5000))

	expect(lease).not.toBeNull()
	expect(lease).toBeInstanceOf(Lease)

	await lease!.release(AbortSignal.timeout(5000))
})

test('tryAcquire returns null when semaphore is full', async () => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, AbortSignal.timeout(5000))

	// Session A fills the semaphore
	let leaseA = await semA.acquire({ count: 1 }, AbortSignal.timeout(5000))

	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let semB = sessionB.semaphore(name)

	let lease = await semB.tryAcquire({ count: 1 }, AbortSignal.timeout(5000))

	expect(lease).toBeNull()

	await leaseA.release(AbortSignal.timeout(5000))
})

test('updates semaphore data', async () => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	let original = Buffer.from('original')
	let updated = Buffer.from('updated')

	await sem.create({ limit: 1, data: original }, AbortSignal.timeout(5000))

	await sem.update(updated, AbortSignal.timeout(5000))

	let description = await sem.describe({}, AbortSignal.timeout(5000))

	expect(Buffer.from(description.data)).toEqual(updated)
})

test('deletes a semaphore', async () => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, AbortSignal.timeout(5000))

	await sem.delete({}, AbortSignal.timeout(5000))

	await expect(sem.describe({}, AbortSignal.timeout(5000))).rejects.toThrow(/NOT_FOUND/i)
})

test('force deletes a semaphore while it is held', async () => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, AbortSignal.timeout(5000))

	// Acquire and deliberately do not release before deleting
	await semA.acquire({ count: 1 }, AbortSignal.timeout(5000))

	// Force delete must succeed even though the semaphore is held
	await expect(semA.delete({ force: true }, AbortSignal.timeout(5000))).resolves.not.toThrow()
})

test('watch emits updated owners when another session acquires', async () => {
	let name = semName()
	let semA = sessionA.semaphore(name)

	await semA.create({ limit: 1 }, AbortSignal.timeout(5000))

	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let semB = sessionB.semaphore(name)

	let watchController = new AbortController()
	let snapshots: Array<{ count: bigint; ownersCount: number }> = []

	// Collect watch events in the background until we see an owner
	let watching = (async () => {
		for await (let snap of semA.watch({ owners: true }, watchController.signal)) {
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

	await using _lease = await semB.acquire({ count: 1 }, AbortSignal.timeout(5000))

	await watching

	expect(snapshots.length).toBeGreaterThanOrEqual(1)
	expect(snapshots.some((s) => s.ownersCount > 0)).toBe(true)
})

test('watch with owners includes session id in owner entries', async () => {
	let name = semName()
	let sem = sessionA.semaphore(name)

	await sem.create({ limit: 1 }, AbortSignal.timeout(5000))

	let lease = await sem.acquire({ count: 1 }, AbortSignal.timeout(5000))

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

	await lease.release(AbortSignal.timeout(5000))

	expect(firstOwnerSessionId).toBe(sessionA.sessionId)
})

test('ephemeral semaphore is removed when the acquiring session is closed', async () => {
	let name = semName()

	// Use a dedicated session so we can close it without affecting sessionA
	let sessionToClose = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let sem = sessionToClose.semaphore(name)

	// Acquire with ephemeral:true — the semaphore is created by the server and
	// tied to this session's lifetime.
	await sem.acquire({ count: 1, ephemeral: true }, AbortSignal.timeout(5000))

	// Close the session gracefully — this sends a session stop to the server
	// which immediately deletes all ephemeral semaphores tied to it.
	await sessionToClose.close(AbortSignal.timeout(5000))

	// The ephemeral semaphore must be gone entirely: describe throws NOT_FOUND.
	let semA = sessionA.semaphore(name)
	await expect(semA.describe({}, AbortSignal.timeout(5000))).rejects.toThrow(/NOT_FOUND/i)
})
