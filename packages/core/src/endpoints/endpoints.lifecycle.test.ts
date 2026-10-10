import { getEventListeners } from 'node:events'
import { memoryUsage } from 'node:process'
import { setImmediate } from 'node:timers/promises'

import { expect, test } from 'vitest'

import { EndpointsUnavailableError } from '../errors.ts'
import {
	capture,
	discoveryResult,
	endpoint,
	makeEndpointPool,
	makeFakeConnectionFactory,
	makeFakeDiscovery,
	settle,
} from './endpoints.fixtures.ts'

let gc = (globalThis as unknown as { gc?: () => void }).gc

let spinUp = function spinUp() {
	let discovery = makeFakeDiscovery()
	discovery.push(discoveryResult([endpoint(1), endpoint(2)]))
	return makeEndpointPool({ discovery })
}

test('churning create/destroy keeps the heap bounded', async () => {
	// Warm up the module + fake machinery so the baseline excludes one-time cost.
	for (let i = 0; i < 200; i++) {
		let h = spinUp()
		h.pool[Symbol.dispose]()
	}
	await settle()

	if (gc === undefined) return // needs --expose-gc; the churn itself still ran.
	gc()
	let before = memoryUsage().heapUsed

	for (let i = 0; i < 5000; i++) {
		let h = spinUp()
		h.pool[Symbol.dispose]()
	}
	await settle()
	gc()
	let after = memoryUsage().heapUsed

	expect(after - before).toBeLessThan(24 * 1024 * 1024)
})

test('ready(signal) leaves no abort listeners on a shared signal', async (tc) => {
	let controller = new AbortController()
	let signal = AbortSignal.any([controller.signal, tc.signal])

	for (let i = 0; i < 50; i++) {
		let h = spinUp()
		// oxlint-disable-next-line no-await-in-loop
		await h.pool.ready(signal)
		// oxlint-disable-next-line no-await-in-loop
		await h.pool.close()
	}

	// abortable() in pool.ready() must remove its abort listener — a shared signal
	// reused across lifecycles must not accumulate abort handlers.
	expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})

test('cancelled ready calls release their reasons before discovery completes', async () => {
	if (gc === undefined) throw new Error('This test requires --expose-gc')
	// A blocked discovery deterministically keeps readiness pending through every cancellation.
	let discovery = makeFakeDiscovery()
	discovery.hang()
	await using h = makeEndpointPool({ discovery })
	await discovery.waitForRound(1)

	let cancelReady = async () => {
		let controller = new AbortController()
		let reason = { cancelled: true }
		let reference = new WeakRef(reason)
		let pending = h.pool.ready(controller.signal)
		controller.abort(reason)
		try {
			await pending
			throw new Error('Cancelled ready resolved')
		} catch (error) {
			if (error !== reason) throw error
		}
		return reference
	}
	let reasons: WeakRef<object>[] = []
	for (let i = 0; i < 100; i++) {
		// oxlint-disable-next-line no-await-in-loop
		reasons.push(await cancelReady())
	}
	for (let i = 0; i < 3; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await setImmediate()
		gc()
	}
	await setImmediate()

	expect(h.machine.state).toBe('discovering')
	expect(discovery.lastSignal()!.aborted).toBe(false)
	expect(reasons.filter((reference) => reference.deref() !== undefined)).toHaveLength(0)
})

test('cancelling one ready waiter leaves the others waiting for published readiness', async (tc) => {
	using readyEvents = capture('ydb:driver.ready')
	await using h = spinUp()
	let controller = new AbortController()
	let reason = new Error('Caller cancelled')
	let cancelled = h.pool.ready(controller.signal).catch((error: unknown) => error)
	let remaining = Promise.all([h.pool.ready(tc.signal), h.pool.ready()]).then(
		() => readyEvents.events.length
	)
	controller.abort(reason)

	expect(await cancelled).toBe(reason)
	expect(await remaining).toBe(1)
	expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
	expect(h.pool.acquire().endpoint.nodeId).toBeDefined()
})

test('rejects ready when close starts before its continuation', async (tc) => {
	await using h = spinUp()
	await h.pool.ready(tc.signal)
	let ready = h.pool.ready(tc.signal)
	let closed = h.pool.close()
	await expect(ready).rejects.toThrow(/closed/i)
	await closed
})

test('close closes every materialized channel and leaves none behind', async (tc) => {
	let connections = makeFakeConnectionFactory()
	let discovery = makeFakeDiscovery()
	discovery.push(discoveryResult([endpoint(1), endpoint(2), endpoint(3)]))
	let h = makeEndpointPool({ discovery, connections })

	await h.pool.ready(tc.signal)
	h.pool.acquire(1n)
	h.pool.acquire(2n)
	h.pool.acquire(3n)
	expect(connections.factoryCalls()).toBe(3)

	await h.pool.close()
	expect(connections.materialized.every((c) => c.closed)).toBe(true)
})

test('destroy aborts an in-flight discovery round and refuses to route', async () => {
	let discovery = makeFakeDiscovery()
	discovery.hang() // the first round blocks until its signal aborts
	let h = makeEndpointPool({ discovery })
	await discovery.waitForRound(1) // the round is genuinely in flight

	h.pool[Symbol.dispose]()
	await settle()

	// The round's signal was aborted by the destroy, and a destroyed pool throws.
	expect(discovery.lastSignal()!.aborted).toBe(true)
	expect(() => h.pool.acquire()).toThrow(EndpointsUnavailableError)
})
