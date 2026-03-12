import { expect, test } from 'vitest'

import {
	SessionReconnectError,
	SessionRequestRegistry,
	createDeferred,
} from './session-registry.ts'

// ── createDeferred ─────────────────────────────────────────────────────────────

test('createDeferred resolves with given value', async () => {
	let d = createDeferred<number>()
	d.resolve(42)
	await expect(d.promise).resolves.toBe(42)
})

test('createDeferred rejects with given reason', async () => {
	let d = createDeferred<number>()
	let error = new Error('boom')
	d.reject(error)
	await expect(d.promise).rejects.toBe(error)
})

test('createDeferred rejection before await does not produce unhandled rejection', () => {
	// The no-op .catch() attached inside createDeferred prevents Node from
	// raising UnhandledPromiseRejection when nobody has subscribed yet.
	// If this test exits cleanly the guard is working.
	let d = createDeferred<void>()
	d.reject(new Error('early reject'))
	// Intentionally not awaiting d.promise — no unhandled rejection should surface.
	// The promise object itself must still exist (sanity check that createDeferred returned one).
	expect(d.promise).toBeInstanceOf(Promise)
})

// ── SessionRequestRegistry — nextReqId ────────────────────────────────────────

test('nextReqId starts at 1 and increments by 1', () => {
	let registry = new SessionRequestRegistry()
	expect(registry.nextReqId()).toBe(1n)
	expect(registry.nextReqId()).toBe(2n)
	expect(registry.nextReqId()).toBe(3n)
})

test('nextReqId throws after close()', () => {
	let registry = new SessionRequestRegistry()
	registry.close()
	expect(() => registry.nextReqId()).toThrow('Session request registry is closed')
})

test('nextReqId throws after destroy()', () => {
	let registry = new SessionRequestRegistry()
	registry.destroy(new Error('gone'))
	expect(() => registry.nextReqId()).toThrow('Session request registry is closed')
})

// ── SessionRequestRegistry — register ─────────────────────────────────────────

test('register returns a deferred keyed by reqId', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)

	expect(deferred).toBeDefined()
	expect(typeof deferred.resolve).toBe('function')
	expect(typeof deferred.reject).toBe('function')
})

test('register throws after close()', () => {
	let registry = new SessionRequestRegistry()
	registry.close()
	expect(() => registry.register(1n)).toThrow('Session request registry is closed')
})

test('register throws after destroy()', () => {
	let registry = new SessionRequestRegistry()
	registry.destroy(new Error('gone'))
	expect(() => registry.register(1n)).toThrow('Session request registry is closed')
})

// ── SessionRequestRegistry — resolve ──────────────────────────────────────────

test('resolve delivers response to registered deferred and returns true', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)

	let fakeResponse = { response: { case: 'createSemaphoreResult', value: { reqId } } } as never
	let resolved = registry.resolve(reqId, fakeResponse)

	expect(resolved).toBe(true)
	await expect(deferred.promise).resolves.toBe(fakeResponse)
})

test('resolve returns false for unknown reqId', () => {
	let registry = new SessionRequestRegistry()
	let fakeResponse = {
		response: { case: 'createSemaphoreResult', value: { reqId: 99n } },
	} as never
	expect(registry.resolve(99n, fakeResponse)).toBe(false)
})

test('resolve removes the request so a second call returns false', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	registry.register(reqId)

	let fakeResponse = { response: { case: 'createSemaphoreResult', value: { reqId } } } as never
	registry.resolve(reqId, fakeResponse)
	expect(registry.resolve(reqId, fakeResponse)).toBe(false)
})

// ── SessionRequestRegistry — delete ───────────────────────────────────────────

test('delete removes a pending request silently', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)

	registry.delete(reqId)

	// resolve should now return false — the slot was removed.
	let fakeResponse = { response: { case: 'createSemaphoreResult', value: { reqId } } } as never
	expect(registry.resolve(reqId, fakeResponse)).toBe(false)

	// The deferred promise itself is never settled — that's intentional.
	// Attach a no-op race so we can confirm nothing settled synchronously.
	let settled = false
	deferred.promise
		.then(() => {
			settled = true
		})
		.catch(() => {
			settled = true
		})
	await Promise.resolve()
	expect(settled).toBe(false)
})

// ── SessionRequestRegistry — reconnect ────────────────────────────────────────

test('reconnect rejects all pending requests with SessionReconnectError', async () => {
	let registry = new SessionRequestRegistry()

	let r1 = registry.register(registry.nextReqId())
	let r2 = registry.register(registry.nextReqId())
	let r3 = registry.register(registry.nextReqId())

	registry.reconnect()

	await expect(r1.promise).rejects.toBeInstanceOf(SessionReconnectError)
	await expect(r2.promise).rejects.toBeInstanceOf(SessionReconnectError)
	await expect(r3.promise).rejects.toBeInstanceOf(SessionReconnectError)
})

test('reconnect clears pending map so subsequent resolve returns false', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	registry.register(reqId)

	registry.reconnect()

	let fakeResponse = { response: { case: 'createSemaphoreResult', value: { reqId } } } as never
	expect(registry.resolve(reqId, fakeResponse)).toBe(false)
})

test('reconnect allows new registrations after reconnecting', () => {
	let registry = new SessionRequestRegistry()
	registry.register(registry.nextReqId())
	registry.reconnect()

	// After reconnect the registry is still open — new requests can be registered.
	expect(() => registry.register(registry.nextReqId())).not.toThrow()
})

test('reconnect is a no-op after close()', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)

	registry.close()
	// close() already rejected all pending; reconnect() must not throw.
	expect(() => registry.reconnect()).not.toThrow()
	await expect(deferred.promise).rejects.toBeDefined()
})

test('reconnect is a no-op after destroy()', () => {
	let registry = new SessionRequestRegistry()
	registry.destroy(new Error('gone'))
	expect(() => registry.reconnect()).not.toThrow()
})

// ── SessionRequestRegistry — close ────────────────────────────────────────────

test('close rejects all pending requests with session closed error', async () => {
	let registry = new SessionRequestRegistry()
	let r1 = registry.register(registry.nextReqId())
	let r2 = registry.register(registry.nextReqId())

	registry.close()

	await expect(r1.promise).rejects.toThrow('Session closed')
	await expect(r2.promise).rejects.toThrow('Session closed')
})

test('close blocks further registrations', () => {
	let registry = new SessionRequestRegistry()
	registry.close()

	expect(() => registry.register(1n)).toThrow('Session request registry is closed')
})

test('close is idempotent across multiple calls', async () => {
	let registry = new SessionRequestRegistry()
	let deferred = registry.register(registry.nextReqId())

	registry.close()
	// Second call must not throw.
	expect(() => registry.close()).not.toThrow()
	// The promise was already rejected by the first close.
	await expect(deferred.promise).rejects.toBeDefined()
})

// ── SessionRequestRegistry — destroy ──────────────────────────────────────────

test('destroy rejects all pending requests with the given reason', async () => {
	let registry = new SessionRequestRegistry()
	let r1 = registry.register(registry.nextReqId())
	let r2 = registry.register(registry.nextReqId())

	let reason = new Error('destroyed')
	registry.destroy(reason)

	await expect(r1.promise).rejects.toBe(reason)
	await expect(r2.promise).rejects.toBe(reason)
})

test('destroy blocks both nextReqId and register', () => {
	let registry = new SessionRequestRegistry()
	registry.destroy(new Error('gone'))

	expect(() => registry.nextReqId()).toThrow('Session request registry is closed')
	expect(() => registry.register(1n)).toThrow('Session request registry is closed')
})

test('destroy is idempotent across multiple calls', async () => {
	let registry = new SessionRequestRegistry()
	let deferred = registry.register(registry.nextReqId())

	let reason = new Error('first destroy')
	registry.destroy(reason)
	// Second call with a different reason must not throw.
	expect(() => registry.destroy(new Error('second destroy'))).not.toThrow()
	// The promise was rejected with the first reason.
	await expect(deferred.promise).rejects.toBe(reason)
})

// ── SessionRequestRegistry — Symbol.dispose ───────────────────────────────────

test('Symbol.dispose rejects pending requests with a dispose error', async () => {
	let registry = new SessionRequestRegistry()
	let deferred = registry.register(registry.nextReqId())

	registry[Symbol.dispose]()

	await expect(deferred.promise).rejects.toThrow('Session request registry disposed')
})

test('Symbol.dispose blocks further use', () => {
	let registry = new SessionRequestRegistry()
	registry[Symbol.dispose]()

	expect(() => registry.nextReqId()).toThrow('Session request registry is closed')
	expect(() => registry.register(1n)).toThrow('Session request registry is closed')
})
