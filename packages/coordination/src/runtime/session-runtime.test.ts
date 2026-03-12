import { afterEach, expect, test, vi } from 'vitest'

import { createRuntime } from './session-runtime.ts'
import {
	makeFakeDriver,
	sessionStartedResponse,
	sessionStoppedResponse,
	settle,
	waitForStatus,
} from './session-runtime.fixtures.ts'

// Ensure fake timers are never leaked across tests.
afterEach(() => {
	vi.useRealTimers()
})

// ── waitReady and sessionId ────────────────────────────────────────────────────

test('waitReady resolves after first sessionStarted', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	let stream = await waitForNextStream()

	stream.respond(sessionStartedResponse(1n))
	await settle()

	await expect(runtime.waitReady()).resolves.toBeUndefined()
	expect(runtime.status).toBe('ready')
	expect(runtime.sessionId).toBe(1n)

	runtime.destroy()
	await waitForStatus(runtime, 'closed')
})

test('sessionId is null before ready and populated after', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })

	expect(runtime.sessionId).toBeNull()

	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(42n))
	await settle()

	expect(runtime.sessionId).toBe(42n)

	runtime.destroy()
	await waitForStatus(runtime, 'closed')
})

test('waitReady blocks during reconnect after first ready', async () => {
	// Use real timers with a very short retryBackoff so the test stays fast
	// without requiring fake-timer control (which complicates promise settling).
	let { driver, waitForNextStream } = makeFakeDriver()

	// Pre-register both stream slots before the runtime starts so we never race
	// against the retry timer firing.
	let firstStreamP = waitForNextStream()
	let secondStreamP = waitForNextStream()

	let runtime = createRuntime(driver, {
		path: '/test',
		startTimeout: 999_999,
		retryBackoff: 5,
		recoveryWindow: 999_999,
	})

	// Bring the session to ready on the first stream.
	let firstStream = await firstStreamP
	firstStream.respond(sessionStartedResponse(1n))
	await waitForStatus(runtime, 'ready')
	expect(runtime.status).toBe('ready')

	// Drop the transport — runtime should move to reconnecting.
	firstStream.disconnect()
	await waitForStatus(runtime, 'reconnecting')
	expect(runtime.status).toBe('reconnecting')

	// waitReady must block now; the old (resolved) readyDeferred should have been
	// replaced with a fresh unresolved one when schedule_retry_backoff ran.
	let resolved = false
	let waitPromise = runtime.waitReady().then(() => {
		resolved = true
	})

	await settle()
	expect(resolved).toBe(false)

	// Wait for the retry backoff (5 ms) to fire and open the second stream.
	let secondStream = await secondStreamP
	secondStream.respond(sessionStartedResponse(1n))
	await waitForStatus(runtime, 'ready')

	// waitReady must have unblocked by now.
	await waitPromise
	expect(resolved).toBe(true)
	expect(runtime.status).toBe('ready')

	runtime.destroy()
	await waitForStatus(runtime, 'closed')
}, 10_000)

test('waitReady rejects when outer signal aborts before first ready', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let ctrl = new AbortController()
	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 }, ctrl.signal)

	// Stream opens but never sends sessionStarted.
	await waitForNextStream()
	await settle()

	// Start waiting for ready, then abort the outer signal.
	let waitPromise = runtime.waitReady()
	ctrl.abort(new Error('cancelled by caller'))

	// The session should close and waitReady should reject.
	await expect(waitPromise).rejects.toBeDefined()
	await waitForStatus(runtime, 'closed')
})

test('waitReady with per-call signal rejects without terminating the session', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	// Stream opens but never sends sessionStarted.
	await waitForNextStream()
	await settle()

	// Abort only the per-call signal, not the session-level signal.
	let callCtrl = new AbortController()
	let waitPromise = runtime.waitReady(callCtrl.signal)

	callCtrl.abort(new Error('per-call timeout'))
	await settle()

	// waitReady rejects with an AbortError DOMException (thrown by abortable).
	await expect(waitPromise).rejects.toBeDefined()
	// The session itself is still alive — only the per-call signal was cancelled.
	expect(runtime.status).toBe('connecting')

	runtime.destroy()
	await waitForStatus(runtime, 'closed')
})

test('waitReady rejects after destroy()', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	await waitForNextStream()
	await settle()

	runtime.destroy(new Error('torn down'))
	await waitForStatus(runtime, 'closed')

	await expect(runtime.waitReady()).rejects.toBeDefined()
})

// ── destroy() and close() ─────────────────────────────────────────────────────

test('destroy() transitions to closed from ready', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })

	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	expect(runtime.status).toBe('ready')

	runtime.destroy()
	await waitForStatus(runtime, 'closed')

	expect(runtime.status).toBe('closed')
})

test('destroy() transitions to closed from connecting', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	// Stream opened but no sessionStarted yet.
	await waitForNextStream()
	await settle()

	expect(runtime.status).toBe('connecting')

	runtime.destroy()
	await waitForStatus(runtime, 'closed')

	expect(runtime.status).toBe('closed')
})

test('destroy() is idempotent across multiple calls', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })
	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	// Multiple destroy calls must not throw or corrupt state.
	runtime.destroy()
	runtime.destroy(new Error('again'))
	runtime.destroy()
	await waitForStatus(runtime, 'closed')

	expect(runtime.status).toBe('closed')
})

test('close() waits for sessionStopped before resolving', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })

	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	expect(runtime.status).toBe('ready')

	let closed = false
	let closePromise = runtime.close().then(() => {
		closed = true
	})

	// FSM moves to closing; close() must still be pending until sessionStopped.
	await waitForStatus(runtime, 'closing')
	expect(closed).toBe(false)

	// Server acknowledges the graceful stop.
	stream.respond(sessionStoppedResponse())
	await waitForStatus(runtime, 'closed')

	await closePromise
	expect(closed).toBe(true)
})

test('close() resolves via disconnect when server drops stream instead of sending stopped', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })

	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	let closePromise = runtime.close()
	await waitForStatus(runtime, 'closing')

	// Server drops the connection instead of sending sessionStopped.
	stream.disconnect()
	await waitForStatus(runtime, 'closed')

	await closePromise
	expect(runtime.status).toBe('closed')
})

test('close() is idempotent when called multiple times', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })

	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	// Start two concurrent close() calls.
	let p1 = runtime.close()
	let p2 = runtime.close()

	await waitForStatus(runtime, 'closing')
	stream.respond(sessionStoppedResponse())
	await waitForStatus(runtime, 'closed')

	// Both promises should resolve without throwing.
	await expect(p1).resolves.toBeUndefined()
	await expect(p2).resolves.toBeUndefined()
})

// ── external and session signals ──────────────────────────────────────────────

test('external signal destroys session through FSM when aborted after ready', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let ctrl = new AbortController()
	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 }, ctrl.signal)

	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	expect(runtime.status).toBe('ready')

	// Outer signal abort dispatches session.destroy — must end in closed, not expired.
	ctrl.abort(new Error('outer shutdown'))
	await waitForStatus(runtime, 'closed')

	expect(runtime.status).toBe('closed')
})

test('external signal already aborted at creation destroys session immediately', async () => {
	let { driver } = makeFakeDriver()

	let ctrl = new AbortController()
	ctrl.abort(new Error('pre-aborted'))

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 }, ctrl.signal)
	await waitForStatus(runtime, 'closed')

	expect(runtime.status).toBe('closed')
})

test('session signal aborts when session is destroyed', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()

	let runtime = createRuntime(driver, { path: '/test', startTimeout: 999_999 })

	let stream = await waitForNextStream()
	stream.respond(sessionStartedResponse(1n))
	await settle()

	expect(runtime.signal.aborted).toBe(false)

	runtime.destroy()
	await waitForStatus(runtime, 'closed')

	expect(runtime.signal.aborted).toBe(true)
})

test('session signal aborts when recovery window expires', async () => {
	// Use real timers with short durations so the test stays fast.
	let { driver, waitForNextStream } = makeFakeDriver()

	let firstStreamP = waitForNextStream()

	let runtime = createRuntime(driver, {
		path: '/test',
		startTimeout: 999_999,
		retryBackoff: 999_999,
		recoveryWindow: 20,
	})

	let firstStream = await firstStreamP
	firstStream.respond(sessionStartedResponse(1n))
	await waitForStatus(runtime, 'ready')

	expect(runtime.status).toBe('ready')
	expect(runtime.signal.aborted).toBe(false)

	// Disconnect — starts recovery window timer (20 ms real time).
	firstStream.disconnect()
	await waitForStatus(runtime, 'reconnecting')
	expect(runtime.status).toBe('reconnecting')

	// Wait for the recovery window to elapse and the session to expire.
	await waitForStatus(runtime, 'expired', 2000)

	expect(runtime.status).toBe('expired')
	expect(runtime.signal.aborted).toBe(true)
}, 10_000)
