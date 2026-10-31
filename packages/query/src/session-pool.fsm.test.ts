import { channel, tracingChannel } from 'node:diagnostics_channel'
import { AsyncLocalStorage } from 'node:async_hooks'

import { abortable } from '@ydbjs/abortable'
import { Driver } from '@ydbjs/core'
import { expect, test } from 'vitest'

import { startClientServer } from './client.fixtures.ts'
import { QueryClient } from './client.ts'
import { SessionPool, SessionPoolClosedError, SessionPoolFullError } from './session-pool.ts'

test('query admission is bounded while driver readiness is blocked', async (tc) => {
	using server = await startClientServer()
	using client = new QueryClient(server.driver, {
		poolOptions: { maxSize: 1, waitQueueFactor: 1 },
	})
	let ready = server.driver.ready.bind(server.driver)
	let gate = Promise.withResolvers<void>()
	server.driver.ready = async (signal) => {
		await abortable(signal, gate.promise)
		await ready(signal)
	}
	let accepted = Promise.allSettled([
		client.retrySession({ signal: tc.signal }, (session) => session.execute('SELECT 1')),
		client.retrySession({ signal: tc.signal }, (session) => session.execute('SELECT 2')),
	])
	try {
		await expect(
			client.retrySession(
				{
					signal: tc.signal,
				},
				(session) => session.execute('SELECT overflow')
			)
		).rejects.toBeInstanceOf(SessionPoolFullError)
		expect(server.executions).toHaveLength(0)
	} finally {
		gate.resolve()
		await accepted
	}
	expect((await accepted).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
	expect(server.executions).toHaveLength(2)
	await client.close()
})

test('queued session creation traces retain each acquiring caller context', async (tc) => {
	let storage = new AsyncLocalStorage<string>()
	using server = await startClientServer()
	using pool = storage.run('constructor', () => new SessionPool(server.driver, { maxSize: 2 }))
	let parents: Array<string | undefined> = []
	let creation = tracingChannel('tracing:ydb:query.session.create')
	let listener = (value: unknown) => {
		if ((value as { driver: unknown }).driver === server.driver.identity)
			parents.push(storage.getStore())
	}
	creation.start.subscribe(listener)
	try {
		let first = storage.run('first', () => pool.acquire(tc.signal))
		let second = storage.run('second', () => pool.acquire(tc.signal))
		let leases = await Promise.all([first, second])
		for (let lease of leases) lease[Symbol.dispose]()
		await pool.close()
		expect(parents).toEqual(['first', 'second'])
	} finally {
		creation.start.unsubscribe(listener)
		storage.disable()
	}
})

test('synchronous admissions are bounded while the pool actor is still applying startup effects', async () => {
	using driver = new Driver('grpc://127.0.0.1:2136/local', { 'ydb.sdk.enable_discovery': false })
	using pool = new SessionPool(driver, { maxSize: 1, waitQueueFactor: 1 })
	pool.beginOperation()
	pool.beginOperation()
	expect(() => pool.beginOperation()).toThrow(SessionPoolFullError)
	let closing = pool.close()
	expect(pool.closed).toBe(true)
	expect(() => pool.beginOperation()).toThrow(SessionPoolClosedError)
	pool.beginOperation(true)
	pool.endOperation()
	pool.endOperation()
	pool.endOperation(true)
	await closing
	expect(pool.signal.aborted).toBe(true)
})

test('reentrant acquired diagnostics stop root admission while allowing an accepted continuation', async (tc) => {
	using server = await startClientServer()
	using pool = new SessionPool(server.driver)
	pool.beginOperation()
	let closing: Promise<void> | undefined
	let closed = false
	let rejected: unknown
	let acquired = channel('ydb:query.session.acquired')
	let listener = (value: unknown) => {
		if ((value as { driver: unknown }).driver !== server.driver.identity) return
		closing = pool.close().then(() => {
			closed = true
			return undefined
		})
		try {
			pool.beginOperation()
		} catch (error) {
			rejected = error
		}
		pool.beginOperation(true)
		pool.endOperation(true)
	}
	acquired.subscribe(listener)
	try {
		let lease = await pool.acquire(tc.signal)
		expect(rejected).toBeInstanceOf(SessionPoolClosedError)
		expect(closed).toBe(false)
		lease[Symbol.dispose]()
		pool.endOperation()
		await closing
		expect(server.deleted).toHaveLength(1)
	} finally {
		acquired.unsubscribe(listener)
	}
})

test('destroy from created diagnostics cancels the session without starting deletion', async (tc) => {
	using server = await startClientServer()
	using pool = new SessionPool(server.driver)
	let created = channel('ydb:query.session.created')
	let deletion = tracingChannel('tracing:ydb:query.session.delete')
	let deletes = 0
	let cancelledSynchronously = false
	let onDelete = (value: unknown) => {
		if ((value as { driver: unknown }).driver === server.driver.identity) deletes++
	}
	let onCreated = (value: unknown) => {
		if ((value as { driver: unknown }).driver !== server.driver.identity) return
		pool.destroy()
		cancelledSynchronously = pool.signal.aborted && pool.stats.total === 0
	}
	created.subscribe(onCreated)
	deletion.start.subscribe(onDelete)
	try {
		await expect(pool.acquire(tc.signal)).rejects.toBeInstanceOf(SessionPoolClosedError)
		await pool.close()
		expect(cancelledSynchronously).toBe(true)
		expect(deletes).toBe(0)
		expect(server.deleted).toHaveLength(0)
	} finally {
		created.unsubscribe(onCreated)
		deletion.start.unsubscribe(onDelete)
	}
})

test('destroy during lease publication preserves paired acquire and release diagnostics', async (tc) => {
	using server = await startClientServer()
	using pool = new SessionPool(server.driver)
	let acquired = channel('ydb:query.session.acquired')
	let released = channel('ydb:query.session.released')
	let acquisitions = 0
	let releases = 0
	let onAcquired = (value: unknown) => {
		if ((value as { driver: unknown }).driver !== server.driver.identity) return
		acquisitions++
		pool.destroy()
	}
	let onReleased = (value: unknown) => {
		if ((value as { driver: unknown }).driver === server.driver.identity) releases++
	}
	acquired.subscribe(onAcquired)
	released.subscribe(onReleased)
	try {
		await expect(pool.acquire(tc.signal)).rejects.toBeInstanceOf(SessionPoolClosedError)
		await pool.close()
		expect(acquisitions).toBe(1)
		expect(releases).toBe(1)
	} finally {
		acquired.unsubscribe(onAcquired)
		released.unsubscribe(onReleased)
	}
})
