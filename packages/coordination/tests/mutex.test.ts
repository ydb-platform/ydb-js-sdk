import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient, type CoordinationSession } from '@ydbjs/coordination'

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
	testNodePath = `/local/test-coord-mutex-${suffix}`

	await client.createNode(testNodePath, {}, ctx.signal)
	session = await client.createSession(testNodePath, {}, ctx.signal)

	onTestFinished(async () => {
		session.destroy()
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})

test('exposes the underlying semaphore name', () => {
	let mutex = session.mutex('my-named-mutex')
	expect(mutex.name).toBe('my-named-mutex')
})

test('auto-creates the ephemeral semaphore on first lock', async (tc) => {
	let mutex = session.mutex(`mutex-${Date.now()}`)

	let lock = await mutex.lock(tc.signal)

	expect(lock.signal.aborted).toBe(false)
	await lock.release(tc.signal)
})

test('returns null from tryLock while another session holds the lock', async (tc) => {
	let name = `mutex-${Date.now()}`

	// Session A takes the lock first.
	let lockA = await session.mutex(name).lock(tc.signal)

	// Session B must not be able to grab it while A still holds it.
	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	await expect(sessionB.mutex(name).tryLock(tc.signal)).resolves.toBeNull()

	await lockA.release(tc.signal)
})

test('succeeds from tryLock once the previous holder releases', async (tc) => {
	let name = `mutex-${Date.now()}`
	let mutex = session.mutex(name)

	// Take and immediately release the lock...
	let lockA = await mutex.lock(tc.signal)
	await lockA.release(tc.signal)

	// ...then confirm a fresh tryLock succeeds now that it's free.
	let lockAgain = await mutex.tryLock(tc.signal)

	expect(lockAgain).not.toBeNull()
	await lockAgain!.release(tc.signal)
})

test('blocks a second session from locking until the first releases', async (tc) => {
	let name = `mutex-${Date.now()}`

	let lockA = await session.mutex(name).lock(tc.signal)

	// Session B's lock() must block while A still holds it.
	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	let acquiredSecond = false
	let lockBPromise = sessionB
		.mutex(name)
		.lock(tc.signal)
		.then((lock) => {
			acquiredSecond = true
			return lock
		})

	// No API exposes "request is now queued" as an awaitable event, so this
	// sleep is a heuristic, not a deterministic proof of blocking (see the
	// matching note in election.test.ts's blocking-campaign test).
	await new Promise((resolve) => setTimeout(resolve, 200))
	expect(acquiredSecond).toBe(false)

	// Once A releases, B's pending lock() must resolve.
	await lockA.release(tc.signal)

	let lockB = await lockBPromise
	expect(acquiredSecond).toBe(true)
	await lockB.release(tc.signal)
})
