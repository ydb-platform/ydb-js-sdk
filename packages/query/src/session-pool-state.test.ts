import assert from 'node:assert/strict'

import { expect, test } from 'vitest'

import {
	type PoolCommand,
	type PoolEvent,
	type PoolState,
	finishPoolOperation,
	poolContext,
	reservePoolOperation,
	transitionPool,
} from './session-pool-state.ts'

function model(maxSize = 1, minSize = 0, maxWaiters = 2) {
	let context = poolContext(maxSize, minSize, maxWaiters)
	let state: PoolState = 'starting'
	let closed = new Error('closed')
	let full = new Error('full')
	let history: PoolCommand[] = []
	let send = (event: PoolEvent) => {
		let result = transitionPool(context, state, event, closed, full)
		state = result.state
		history.push(...result.commands)
		if (state === 'open' || state === 'draining')
			assert.ok(context.sessions.size + context.creates.size <= maxSize)
		assert.equal(new Set(context.idle).size, context.idle.length)
		for (let session of context.idle) assert.equal(context.sessions.get(session), 'idle')
		for (let request of context.waiters) assert.equal(context.requests.get(request), 'waiting')
		for (let [session, slot] of context.sessions) {
			if (slot === 'leased') assert.ok(context.leases.has(session))
			if (typeof slot === 'object')
				assert.deepEqual(context.requests.get(slot.request), { session })
		}
		return result
	}
	send({ type: 'start' })
	return {
		context,
		history,
		send,
		closed,
		full,
		get state() {
			return state
		},
	}
}

test('root admission is bounded before queued effects or driver readiness complete', () => {
	let pool = model(1, 0, 1)
	expect(reservePoolOperation(pool.context, false, false)).toBeUndefined()
	expect(reservePoolOperation(pool.context, false, false)).toBeUndefined()
	expect(reservePoolOperation(pool.context, false, false)).toBe('full')
	expect(pool.context.rootOperations).toBe(2)
	expect(pool.context.requests.size).toBe(0)
	finishPoolOperation(pool.context, false)
	expect(reservePoolOperation(pool.context, false, false)).toBeUndefined()
	expect(pool.context.rootOperations).toBe(2)
})

test('draining rejects new roots but lets accepted attempts finish before pool shutdown', () => {
	let pool = model()
	reservePoolOperation(pool.context, false, false)
	pool.send({ type: 'close' })
	expect(pool.state).toBe('draining')
	expect(reservePoolOperation(pool.context, false, true)).toBe('closed')
	expect(reservePoolOperation(pool.context, true, true)).toBeUndefined()
	finishPoolOperation(pool.context, false)
	expect(pool.send({ type: 'progress' }).commands).toEqual([])
	expect(pool.state).toBe('draining')
	finishPoolOperation(pool.context, true)
	let terminal = pool.send({ type: 'progress' })
	expect(terminal.state).toBe('closed')
	expect(terminal.commands).toEqual([{ type: 'abort' }, { type: 'closed' }])
	expect(terminal.final).toBe(true)
})

test('a failed create transfers capacity to the oldest waiter instead of retrying in the background', () => {
	let pool = model()
	pool.send({ type: 'acquire', request: 10 })
	pool.send({ type: 'acquire', request: 11 })
	pool.send({ type: 'acquire', request: 12 })
	let failure = new Error('creation failed')
	let next = pool.send({ type: 'create_failed', creation: 0, error: failure })
	expect(next.commands).toEqual([
		{ type: 'reject', request: 10, error: failure },
		{ type: 'dequeued', request: 11 },
		{ type: 'create', creation: 1, request: 11 },
	])
	expect([...pool.context.waiters]).toEqual([12])
	pool.send({ type: 'created', creation: 1 })
	pool.send({ type: 'accept', request: 11 })
	expect(pool.context.sessions.get(1)).toBe('leased')
	expect([...pool.context.creates]).toEqual([])
})

test('best-effort warm-up failure does not create an unbounded retry loop', () => {
	let pool = model(2, 2)
	expect(pool.context.creates.size).toBe(2)
	expect(
		pool.send({ type: 'create_failed', creation: 0, error: new Error('offline') }).commands
	).toEqual([])
	expect(
		pool.send({ type: 'create_failed', creation: 1, error: new Error('offline') }).commands
	).toEqual([])
	expect(pool.context.creates.size).toBe(0)
	expect(pool.history.filter((command) => command.type === 'create')).toHaveLength(2)
})

test('cancellation during an offered handoff serves the next waiter without issuing another lease', () => {
	let pool = model()
	pool.send({ type: 'acquire', request: 0 })
	pool.send({ type: 'created', creation: 0 })
	pool.send({ type: 'accept', request: 0 })
	pool.send({ type: 'acquire', request: 1 })
	pool.send({ type: 'acquire', request: 2 })
	pool.send({ type: 'release', session: 0, serverId: 'session', nodeId: 1n })
	let reason = new Error('cancel handoff')
	let cancelled = pool.send({ type: 'cancel', request: 1, reason })
	expect(cancelled.commands).toContainEqual({ type: 'offer', request: 2, session: 0 })
	expect(cancelled.commands).toContainEqual({ type: 'reject', request: 1, error: reason })
	expect(cancelled.commands.some((command) => command.type === 'released')).toBe(false)
	expect(pool.send({ type: 'accept', request: 1 }).commands).toEqual([])
	expect(pool.send({ type: 'accept', request: 2 }).commands).toEqual([
		{ type: 'deliver', request: 2, session: 0 },
	])
	expect([...pool.context.leases]).toEqual([0])
})

test('cancellation after dequeue keeps the create owned until its completion', () => {
	let pool = model()
	pool.send({ type: 'acquire', request: 0 })
	pool.send({ type: 'acquire', request: 1 })
	pool.send({ type: 'create_failed', creation: 0, error: new Error('failed') })
	let reason = new Error('cancel create')
	let cancelled = pool.send({ type: 'cancel', request: 1, reason })
	expect(cancelled.commands).toEqual([
		{ type: 'cancel_create', creation: 1, reason },
		{ type: 'reject', request: 1, error: reason },
	])
	pool.send({ type: 'acquire', request: 2 })
	expect(pool.context.creates.size).toBe(1)
	expect(pool.context.waiters.size).toBe(1)
	pool.send({ type: 'create_failed', creation: 1, error: reason })
	expect(pool.context.requests.get(2)).toEqual({ creation: 2 })
})

test('session loss replaces live capacity but a late lease release cannot lend the replacement twice', () => {
	let pool = model()
	pool.send({ type: 'acquire', request: 0 })
	pool.send({ type: 'created', creation: 0 })
	pool.send({ type: 'accept', request: 0 })
	pool.send({ type: 'acquire', request: 1 })
	pool.send({ type: 'lost', session: 0, reason: 'stream_error', error: new Error('lost') })
	pool.send({ type: 'created', creation: 1 })
	pool.send({ type: 'accept', request: 1 })
	let released = pool.send({ type: 'release', session: 0, serverId: 'old', nodeId: 1n })
	expect(released.commands).toEqual([{ type: 'released', serverId: 'old', nodeId: 1n }])
	expect(pool.context.sessions.get(1)).toBe('leased')
	expect(pool.context.idle).toEqual([])
	expect(
		pool.send({ type: 'release', session: 0, serverId: 'old', nodeId: 1n }).commands
	).toEqual([])
})

test.for(['created', 'create_failed'] as const)(
	'destroy handles a late %s without starting deletion RPCs',
	(type) => {
		let pool = model()
		pool.send({ type: 'acquire', request: 0 })
		let destroyed = pool.send({ type: 'destroy' })
		expect(destroyed.state).toBe('destroyed')
		expect(destroyed.final).toBe(false)
		expect(destroyed.commands).toContainEqual({ type: 'closed' })
		let result = pool.send(
			type === 'created'
				? { type, creation: 0 }
				: { type, creation: 0, error: new Error('aborted') }
		)
		expect(
			result.commands.every(
				(command) => command.type !== 'retire' || command.mode !== 'close'
			)
		).toBe(true)
		expect(result.final).toBe(true)
		expect(pool.history.filter((command) => command.type === 'closed')).toHaveLength(1)
	}
)

test('graceful close owns session deletion and publishes closure only once', () => {
	let pool = model()
	pool.send({ type: 'acquire', request: 0 })
	pool.send({ type: 'created', creation: 0 })
	pool.send({ type: 'accept', request: 0 })
	let closing = pool.send({ type: 'close' })
	expect(closing.state).toBe('closing')
	expect(closing.commands).toContainEqual({
		type: 'retire',
		session: 0,
		reason: 'pool_close',
		mode: 'close',
		announce: true,
	})
	pool.send({ type: 'release', session: 0, serverId: 'session', nodeId: 1n })
	let closed = pool.send({ type: 'session_closed', session: 0 })
	expect(closed.state).toBe('closed')
	expect(closed.final).toBe(true)
	pool.send({ type: 'destroy' })
	expect(pool.history.filter((command) => command.type === 'closed')).toHaveLength(1)
})
