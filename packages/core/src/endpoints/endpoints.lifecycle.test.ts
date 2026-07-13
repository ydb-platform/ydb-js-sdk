import { getEventListeners } from 'node:events'
import { memoryUsage } from 'node:process'

import { expect, test } from 'vitest'

import { EndpointsUnavailableError } from '../errors.ts'
import {
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
