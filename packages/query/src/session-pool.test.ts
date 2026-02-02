import { afterEach, expect, test, vi } from 'vitest'

import type { Driver } from '@ydbjs/core'
import { Session, SessionState } from './session.ts'
import { SessionPool } from './session-pool.ts'

function createMockDriver(): Driver {
	return {
		database: '/local',
		createClient: vi.fn(),
	} as unknown as Driver
}

/**
 * Mock session with the same state invariants as real Session:
 * - acquire only from IDLE
 * - release only from BUSY
 * - delete transitions to CLOSED
 */
function createMockSession(id = 'test-session-id'): Session {
	let state: SessionState = SessionState.IDLE

	return {
		id,
		nodeId: 1n,

		get state() {
			return state
		},
		get isIdle() {
			return state === SessionState.IDLE
		},
		get isBusy() {
			return state === SessionState.BUSY
		},
		get isClosed() {
			return state === SessionState.CLOSED
		},

		acquire: vi.fn(() => {
			if (state !== SessionState.IDLE) {
				throw new Error(`Cannot acquire session in state ${state}`)
			}
			state = SessionState.BUSY
		}),

		release: vi.fn(() => {
			if (state !== SessionState.BUSY) {
				throw new Error(`Cannot release session in state ${state}`)
			}
			state = SessionState.IDLE
		}),

		delete: vi.fn(async () => {
			state = SessionState.CLOSED
		}),
	} as unknown as Session
}

let pool: SessionPool | undefined

afterEach(async () => {
	await pool?.close()
	pool = undefined

	vi.restoreAllMocks()
})

test('creates pool with default options', () => {
	const driver = createMockDriver()
	pool = new SessionPool(driver)

	expect(pool.stats).toEqual({
		total: 0,
		idle: 0,
		busy: 0,
		closed: 0,
		waiting: 0,
		maxSize: 50,
	})
})

test('reuses idle session (Session.create called once)', async () => {
	const driver = createMockDriver()
	pool = new SessionPool(driver, { maxSize: 10 })

	const s1 = createMockSession('s1')
	vi.spyOn(Session, 'create').mockResolvedValue(s1)

	const a1 = await pool.acquire()
	pool.release(a1)

	expect(pool.stats.idle).toBe(1)
	expect(pool.stats.busy).toBe(0)

	const a2 = await pool.acquire()
	expect(a2).toBe(a1)
	expect(Session.create).toHaveBeenCalledTimes(1)

	expect(pool.stats.idle).toBe(0)
	expect(pool.stats.busy).toBe(1)
})

test('does not create more than maxSize', async () => {
	const driver = createMockDriver()
	pool = new SessionPool(driver, { maxSize: 2 })

	const created: Session[] = []
	vi.spyOn(Session, 'create').mockImplementation(async () => {
		const s = createMockSession(`s${created.length + 1}`)
		created.push(s)
		return s
	})

	const [a, b, c] = [pool.acquire(), pool.acquire(), pool.acquire()]

	expect(pool.stats.waiting).toBe(1)

	const s1 = await a
	const _s2 = await b

	expect(Session.create).toHaveBeenCalledTimes(2)
	expect(pool.stats.total).toBe(2)
	expect(pool.stats.busy).toBe(2)

	pool.release(s1)
	const s3 = await c
	expect(s3).toBe(s1)

	expect(Session.create).toHaveBeenCalledTimes(2)
	expect(pool.stats.total).toBe(2)
})

test('waiters are served in FIFO order', async () => {
	const driver = createMockDriver()
	pool = new SessionPool(driver, { maxSize: 1 })

	const s1 = createMockSession('s1')
	vi.spyOn(Session, 'create').mockResolvedValue(s1)

	const acquired = await pool.acquire()

	const w1 = pool.acquire()
	const w2 = pool.acquire()
	const w3 = pool.acquire()

	pool.release(acquired)
	const r1 = await w1
	expect(r1).toBe(acquired)
	expect(pool.stats.waiting).toBe(2)

	pool.release(r1)
	const r2 = await w2
	expect(r2).toBe(acquired)
	expect(pool.stats.waiting).toBe(1)

	pool.release(r2)
	const r3 = await w3
	expect(r3).toBe(acquired)
	expect(pool.stats.waiting).toBe(0)
})

test('abort during waiting removes waiter from queue', async () => {
	const driver = createMockDriver()
	pool = new SessionPool(driver, { maxSize: 1 })

	const s1 = createMockSession('s1')
	vi.spyOn(Session, 'create').mockResolvedValue(s1)

	await pool.acquire()

	const controller = new AbortController()
	const p = pool.acquire(controller.signal)

	controller.abort(new Error('Aborted by test'))
	await expect(p).rejects.toThrow(/abort/i)

	expect(pool.stats.waiting).toBe(0)
})

test('session creation failure rejects waiters but allows retry', async () => {
	const driver = createMockDriver()
	pool = new SessionPool(driver, { maxSize: 1 })

	let attempt = 0
	vi.spyOn(Session, 'create').mockImplementation(async () => {
		attempt++
		if (attempt === 1) throw new Error('create failed')
		return createMockSession(`s${attempt}`)
	})

	const p1 = pool.acquire()

	const p2 = pool.acquire()

	await expect(p1).rejects.toThrow('create failed')
	await expect(p2).rejects.toThrow(/session creation failed|create failed/i)

	expect(pool.stats.total).toBe(0)
	expect(pool.stats.waiting).toBe(0)
})

test('close(): rejects waiters and deletes all sessions (and does not throw on delete errors)', async () => {
	const driver = createMockDriver()
	pool = new SessionPool(driver, { maxSize: 2 })

	const s1 = createMockSession('s1')
	const s2 = createMockSession('s2')
	vi.spyOn(Session, 'create')
		.mockResolvedValueOnce(s1)
		.mockResolvedValueOnce(s2)

	const a1 = await pool.acquire()
	const a2 = await pool.acquire()

	const waiter = pool.acquire()

	vi.spyOn(a2, 'delete').mockRejectedValueOnce(new Error('delete failed'))

	await expect(pool.close()).resolves.toBeUndefined()
	await expect(waiter).rejects.toThrow(/closed/i)

	expect(a1.delete).toHaveBeenCalledTimes(1)
	expect(a2.delete).toHaveBeenCalledTimes(1)

	expect(pool.stats.total).toBe(0)
	expect(pool.stats.waiting).toBe(0)
})
