import { afterEach, expect, test, vi } from 'vitest'

import { CoordinationClient } from './client.ts'
import {
	makeFakeDriver,
	sessionStartedResponse,
	settle,
} from './runtime/session-runtime.fixtures.ts'

// recoveryWindow-driven expiry is a purely client-side timer, but there's no
// public API to sever just this session's transport against a real server
// without tearing down the whole Driver (which would also break the reopened
// session) — the only demonstrated real-disconnect technique in this repo
// (packages/topic/tests/reconnect.test.ts) relies on discovery-driven pool
// churn over 60+ seconds, which doesn't transfer to a single session stream.
// So this scenario stays on the fake-driver fixture already used by
// ./runtime/session-runtime.test.ts. Everything else about CoordinationClient
// (node CRUD, session creation, withSession, openSession's happy path and
// external-signal cancellation) is covered by real-YDB integration tests
// under packages/coordination/tests/.
afterEach(() => {
	vi.useRealTimers()
})

test('reopens automatically once the current session expires', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()
	let client = new CoordinationClient(driver)

	// Pre-register both stream slots so we never race the reopen against the
	// fake driver delivering the handle before we're listening for it.
	let firstStreamP = waitForNextStream()
	let secondStreamP = waitForNextStream()

	let seen: bigint[] = []

	let iterating = (async () => {
		for await (let session of client.openSession('/test', {
			startTimeout: 999_999,
			retryBackoff: 999_999,
			recoveryWindow: 20,
		})) {
			seen.push(session.sessionId!)

			if (seen.length === 1) {
				// Drop the transport — with retryBackoff effectively disabled and a
				// 20 ms recovery window, the session moves reconnecting → expired,
				// which is what openSession()'s reopen loop watches for.
				let stream = await firstStreamP
				stream.disconnect()
				continue
			}

			// Second session received — the reopen behavior is confirmed.
			// `break` lets the generator finish naturally, no external
			// AbortController required.
			session.destroy()
			break
		}
	})()

	// Bring the first session to ready — triggers the disconnect above.
	let firstStream = await firstStreamP
	firstStream.respond(sessionStartedResponse(1n))
	await settle()

	// Reopen lands on the second stream — bring it to ready too.
	let secondStream = await secondStreamP
	secondStream.respond(sessionStartedResponse(2n))

	await iterating

	expect(seen).toEqual([1n, 2n])
}, 10_000)

// Regression test for a real hang: linkSignals() aborts its combined signal
// synchronously when an input is already aborted, without ever firing a
// future 'abort' event. shouldOpenNextSession used to attach only a live
// listener, so if the caller's signal was already aborted by the time the
// reopen check ran, it would await a promise that never resolves.
test('does not hang when the external signal is already aborted by the time the reopen check runs', async () => {
	let { driver, waitForNextStream } = makeFakeDriver()
	let client = new CoordinationClient(driver)

	let ctrl = new AbortController()
	let firstStreamP = waitForNextStream()

	let iterating = (async () => {
		for await (let _ of client.openSession('/test', { startTimeout: 999_999 }, ctrl.signal)) {
			// Abort synchronously, before the generator resumes past `yield` —
			// this is the exact race that used to hang shouldOpenNextSession.
			ctrl.abort(new Error('caller cancelled synchronously'))
		}
	})()

	let stream = await firstStreamP
	stream.respond(sessionStartedResponse(1n))

	let outcome = await Promise.race([
		iterating.then(() => 'completed' as const),
		new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
	])

	expect(outcome).toBe('completed')
}, 10_000)
