import { getEventListeners } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

import { LeaseReleasedError } from './errors.ts'
import { Semaphore } from './semaphore.ts'
import { createRuntime } from './runtime/session-runtime.ts'
import {
	makeFakeDriver,
	sessionStartedResponse,
	settle,
	waitForStatus,
} from './runtime/session-runtime.fixtures.ts'

afterEach(() => {
	vi.useRealTimers()
})

let listenerCount = function listenerCount(signal: AbortSignal): number {
	return getEventListeners(signal, 'abort').length
}

// ── Listener leak prevention ─────────────────────────────────────────────────

test('transport.call does not leak listeners on user signal', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	let userAC = new AbortController()

	for (let i = 0; i < 100; i++) {
		let callPromise = runtime.transport.call(
			(rid) => ({
				request: {
					case: 'createSemaphore',
					value: { reqId: rid, name: 'test', limit: 1n, data: new Uint8Array() },
				},
			}),
			userAC.signal
		)

		// oxlint-disable-next-line no-await-in-loop
		await settle(10)

		stream.respond({
			response: {
				case: 'createSemaphoreResult',
				value: { reqId: BigInt(i + 1), status: 400000, issues: [] },
			},
		} as any)

		// oxlint-disable-next-line no-await-in-loop
		await callPromise
	}

	expect(listenerCount(userAC.signal)).toBe(0)

	runtime.destroy()
	await waitForStatus(runtime, 'closed')
})

test('transport.waitReady does not leak listeners on user signal', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	let userAC = new AbortController()

	for (let i = 0; i < 100; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await runtime.transport.waitReady(userAC.signal)
	}

	expect(listenerCount(userAC.signal)).toBe(0)

	runtime.destroy()
	await waitForStatus(runtime, 'closed')
})

// ── Lease signal ─────────────────────────────────────────────────────────────

test('lease.signal is independent from session.signal', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	let semaphore = new Semaphore('test-sem', runtime.transport, runtime.signal)

	let acquirePromise = semaphore.acquire({ count: 1 })
	await settle(10)

	stream.respond({
		response: {
			case: 'acquireSemaphoreResult',
			value: { reqId: 1n, status: 400000, issues: [], acquired: true },
		},
	} as any)

	let lease = await acquirePromise
	expect(lease.signal.aborted).toBe(false)

	runtime.destroy(new Error('session over'))
	await waitForStatus(runtime, 'closed')

	expect(runtime.signal.aborted).toBe(true)
	expect(lease.signal.aborted).toBe(false)
})

test('lease.signal aborts with LeaseReleasedError after release', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	let semaphore = new Semaphore('test-sem', runtime.transport, runtime.signal)

	// Acquire
	let acquirePromise = semaphore.acquire({ count: 1 })
	await settle(10)

	stream.respond({
		response: {
			case: 'acquireSemaphoreResult',
			value: { reqId: 1n, status: 400000, issues: [], acquired: true },
		},
	} as any)

	let lease = await acquirePromise
	expect(lease.signal.aborted).toBe(false)

	// Release
	let releasePromise = lease.release()
	await settle(10)

	stream.respond({
		response: {
			case: 'releaseSemaphoreResult',
			value: { reqId: 2n, status: 400000, issues: [], released: true },
		},
	} as any)

	await releasePromise

	expect(lease.signal.aborted).toBe(true)
	expect(lease.signal.reason).toBeInstanceOf(LeaseReleasedError)

	// Session still alive
	expect(runtime.signal.aborted).toBe(false)

	runtime.destroy()
	await waitForStatus(runtime, 'closed')
})
