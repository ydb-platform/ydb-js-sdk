import { expect, inject, test } from 'vitest'

import { Driver } from '@ydbjs/core'

import { Session, SessionBusyError } from '../src/session.ts'
import { SessionLease, SessionPool, SessionPoolFullError } from '../src/session-pool.ts'

// Golden-path SessionPool/Session/SessionLease behavior against real YDB.
// Scenarios that need server-side fault injection (killing a session's
// stream mid-flight, holding CreateSession open, forcing a bad first attach
// message) stay on the nice-grpc mock server in ../src/session-pool.test.ts
// — there's no way to trigger those deterministically against a real server.
let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

/** Poll a condition until true or timeout — pool warm-up runs in the background. */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	let deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (cond()) return
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error(`timed out waiting for condition (${timeoutMs}ms)`)
}

test('reuses the most recently released session first (LIFO)', async (tc) => {
	await using pool = new SessionPool(driver, { maxSize: 2 })

	let a = await pool.acquire(tc.signal)
	let b = await pool.acquire(tc.signal)
	let idA = a.id
	let idB = b.id
	expect(idA).not.toBe(idB)

	a[Symbol.dispose]()
	b[Symbol.dispose]() // top of the stack

	let next = await pool.acquire(tc.signal)
	expect(next.id).toBe(idB)
})

test('rejects new waiters once the wait queue hits the cap', async (tc) => {
	await using pool = new SessionPool(driver, { maxSize: 1, waitQueueFactor: 2 })

	await pool.acquire(tc.signal) // hold the only session

	let w1 = pool.acquire(tc.signal)
	let w2 = pool.acquire(tc.signal)
	expect(pool.stats.waiting).toBe(2)

	await expect(pool.acquire(tc.signal)).rejects.toBeInstanceOf(SessionPoolFullError)

	// Orphan the waiters — pool disposal at scope end rejects them.
	w1.catch(() => {})
	w2.catch(() => {})
})

test('exposes id and nodeId on a lease', async (tc) => {
	await using pool = new SessionPool(driver, { maxSize: 1 })

	let lease = await pool.acquire(tc.signal)
	expect(lease).toBeInstanceOf(SessionLease)
	expect(typeof lease.id).toBe('string')
	expect(typeof lease.nodeId).toBe('bigint')
})

test('throws SessionBusyError on a second concurrent claim', async (tc) => {
	let session = await Session.open(driver, tc.signal)

	try {
		using _ = session.claim()
		expect(() => session.claim()).toThrow(SessionBusyError)
	} finally {
		session.close('pool_close')
	}
})

test('releases the claim on dispose so a second claim succeeds', async (tc) => {
	let session = await Session.open(driver, tc.signal)

	{
		using _ = session.claim()
		// scope holds the slot
	}

	expect(() => {
		using _ = session.claim()
	}).not.toThrow()
	session.close('pool_close')
})

test('disposing a claim twice does not throw', async (tc) => {
	let session = await Session.open(driver, tc.signal)

	let held = session.claim()
	held[Symbol.dispose]()
	expect(() => held[Symbol.dispose]()).not.toThrow()

	expect(() => {
		using _ = session.claim()
	}).not.toThrow()
	session.close('pool_close')
})

test('warms the pool up to minSize on construction', async () => {
	await using pool = new SessionPool(driver, { maxSize: 5, minSize: 3 })

	await until(() => pool.stats.total === 3)

	expect(pool.stats.total).toBe(3)
	expect(pool.stats.idle).toBe(3)
	expect(pool.stats.busy).toBe(0)
})

test('does not warm any sessions when minSize defaults to 0', async () => {
	await using pool = new SessionPool(driver, { maxSize: 5 })

	// Give the event loop a chance — if warm-up were misfiring, creates
	// would have started by now.
	await new Promise((r) => setTimeout(r, 200))

	expect(pool.stats.total).toBe(0)
	expect(pool.stats.creating).toBe(0)
})

test('throws RangeError when minSize exceeds maxSize', () => {
	expect(() => new SessionPool(driver, { maxSize: 2, minSize: 5 })).toThrow(RangeError)
})
