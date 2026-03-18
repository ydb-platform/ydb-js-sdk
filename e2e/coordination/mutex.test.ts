import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient, Lease } from '@ydbjs/coordination'
import type { CoordinationSession } from '@ydbjs/coordination'

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
	testNodePath = `/local/test-coord-mtx-${suffix}`

	await client.createNode(testNodePath, {}, AbortSignal.timeout(5000))

	sessionA = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	onTestFinished(async () => {
		await sessionA.close(AbortSignal.timeout(5000)).catch(() => {})
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})
// #endregion

// Helper: unique mutex name per call so tests never collide even within a file
let mtxName = () => `mtx-${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`

test('lock acquires exclusive access', async () => {
	let mutex = sessionA.mutex(mtxName())

	let lock = await mutex.lock(AbortSignal.timeout(5000))

	expect(lock).toBeInstanceOf(Lease)
	// Signal must be alive while the lock is held
	expect(lock.signal.aborted).toBe(false)

	await lock.release(AbortSignal.timeout(5000))
})

test('async dispose releases the lock', async () => {
	let mutex = sessionA.mutex(mtxName())
	let capturedSignal: AbortSignal

	{
		await using lock = await mutex.lock(AbortSignal.timeout(5000))
		capturedSignal = lock.signal
		expect(capturedSignal.aborted).toBe(false)
	}

	// After dispose the session-level signal may or may not abort, but the test
	// verifies that dispose does not throw — that is the core contract.
	// A second lock attempt proves the mutex is free again.
	let lock2 = await mutex.lock(AbortSignal.timeout(5000))
	expect(lock2).toBeInstanceOf(Lease)
	await lock2.release(AbortSignal.timeout(5000))
})

test('second lock blocks until first is released', async () => {
	let name = mtxName()
	let mutexA = sessionA.mutex(name)

	// Session A acquires the mutex
	let lockA = await mutexA.lock(AbortSignal.timeout(5000))

	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let mutexB = sessionB.mutex(name)

	// Session B starts waiting — pass an explicit waitTimeout so the server
	// keeps the request open instead of returning a miss immediately.
	let acquireB = mutexB.lock(AbortSignal.timeout(10000))

	// Release A's lock so B can proceed
	await lockA.release(AbortSignal.timeout(5000))

	await using lockB = await acquireB

	expect(lockB).toBeInstanceOf(Lease)
	expect(lockB.signal.aborted).toBe(false)
})

test('tryLock succeeds when mutex is free', async () => {
	let mutex = sessionA.mutex(mtxName())

	let lock = await mutex.tryLock(AbortSignal.timeout(5000))

	expect(lock).not.toBeNull()
	expect(lock).toBeInstanceOf(Lease)

	await lock!.release(AbortSignal.timeout(5000))
})

test('tryLock returns null when mutex is already locked', async () => {
	let name = mtxName()
	let mutexA = sessionA.mutex(name)

	// Session A holds the lock
	let lockA = await mutexA.lock(AbortSignal.timeout(5000))

	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let mutexB = sessionB.mutex(name)

	let lock = await mutexB.tryLock(AbortSignal.timeout(5000))

	expect(lock).toBeNull()

	await lockA.release(AbortSignal.timeout(5000))
})

test('concurrent locks serialize execution', async () => {
	// N sessions race for the same mutex.  Each one increments a shared counter
	// stored in a semaphore's data field while it holds the lock.  If the mutex
	// provides true exclusion the final value equals N and no increment is lost.
	let name = mtxName()
	let N = 4
	let COUNTER_SEM = `${name}-counter`

	// Create a persistent semaphore to hold the counter in its data field
	let counterSem = sessionA.semaphore(COUNTER_SEM)
	await counterSem.create({ limit: 1, data: encodeCounter(0) }, AbortSignal.timeout(5000))

	let sessions: CoordinationSession[] = []
	for (let i = 0; i < N; i++) {
		// oxlint-disable-next-line no-await-in-loop
		sessions.push(await client.createSession(testNodePath, {}, AbortSignal.timeout(5000)))
	}

	try {
		// All sessions race concurrently — no sequential awaiting
		await Promise.all(
			sessions.map(async (session) => {
				let mutex = session.mutex(name)
				let sem = session.semaphore(COUNTER_SEM)

				await using _lock = await mutex.lock(AbortSignal.timeout(15000))

				// Read → increment → write while holding the exclusive lock
				let description = await sem.describe({}, AbortSignal.timeout(5000))
				let current = decodeCounter(description.data)
				await sem.update(encodeCounter(current + 1), AbortSignal.timeout(5000))
			})
		)

		// All N increments must have gone through without any being lost
		let final = await counterSem.describe({}, AbortSignal.timeout(5000))
		expect(decodeCounter(final.data)).toBe(N)
	} finally {
		// Sessions are created outside the using scope because Promise.all needs
		// them all alive simultaneously — close them manually in the finally block.
		for (let session of sessions) {
			// oxlint-disable-next-line no-await-in-loop
			await session.close(AbortSignal.timeout(5000)).catch(() => {})
		}
	}
})

let encodeCounter = (n: number): Uint8Array => {
	let buf = Buffer.alloc(4)
	buf.writeUInt32BE(n, 0)
	return buf
}

let decodeCounter = (data: Uint8Array): number => {
	return Buffer.from(data).readUInt32BE(0)
}
