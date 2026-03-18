import type { SessionResponse } from '@ydbjs/api/coordination'
import type { Driver } from '@ydbjs/core'

import { createDeferred } from './session-registry.ts'
import type { SessionRuntime, SessionStatus } from './session-runtime.ts'

// ── fake stream infrastructure ─────────────────────────────────────────────────

// A handle returned to the test for each stream instance the runtime opens.
export type FakeStreamHandle = {
	/** Push a server response message into the open stream. */
	respond(response: SessionResponse): void
	/** End the stream as if the transport was lost. */
	disconnect(): void
}

export type FakeDriverHandle = {
	driver: Driver
	/**
	 * Returns a promise that resolves with the handle for the next stream the
	 * runtime opens.  Call this before OR after the runtime opens the stream —
	 * the implementation queues handles either way.
	 */
	waitForNextStream(): Promise<FakeStreamHandle>
}

export let makeFakeDriver = function makeFakeDriver(): FakeDriverHandle {
	// Supports either ordering: the test can wait before or after session() is called.
	let pendingHandles: FakeStreamHandle[] = []
	let pendingWaiters: Array<(handle: FakeStreamHandle) => void> = []

	let waitForNextStream = function waitForNextStream(): Promise<FakeStreamHandle> {
		if (pendingHandles.length > 0) {
			return Promise.resolve(pendingHandles.shift()!)
		}
		let deferred = createDeferred<FakeStreamHandle>()
		pendingWaiters.push(deferred.resolve)
		return deferred.promise
	}

	let deliverHandle = function deliverHandle(handle: FakeStreamHandle): void {
		if (pendingWaiters.length > 0) {
			pendingWaiters.shift()!(handle)
		} else {
			pendingHandles.push(handle)
		}
	}

	let driver = {
		createClient(): unknown {
			return {
				session(
					_input: unknown,
					opts?: { signal?: AbortSignal }
				): AsyncIterable<SessionResponse> {
					let signal = opts?.signal
					// Readers waiting for the next stream item.
					let readers: Array<(result: IteratorResult<SessionResponse>) => void> = []
					let queue: SessionResponse[] = []
					let done = false

					let finish = function finish(): void {
						done = true
						for (let reader of readers.splice(0)) {
							reader({ value: undefined as unknown as SessionResponse, done: true })
						}
					}

					// When the stream's abort signal fires, end all pending readers so that
					// closeStream / ingest[Symbol.asyncDispose]() can complete without deadlocking.
					if (signal) {
						if (signal.aborted) {
							done = true
						} else {
							signal.addEventListener('abort', finish, { once: true })
						}
					}

					let handle: FakeStreamHandle = {
						respond(response) {
							if (done) return
							if (readers.length > 0) {
								readers.shift()!({ value: response, done: false })
							} else {
								queue.push(response)
							}
						},
						disconnect() {
							finish()
						},
					}

					deliverHandle(handle)

					return {
						[Symbol.asyncIterator]() {
							return {
								next(): Promise<IteratorResult<SessionResponse>> {
									if (queue.length > 0) {
										return Promise.resolve({
											value: queue.shift()!,
											done: false,
										})
									}
									if (done) {
										return Promise.resolve({
											value: undefined as unknown as SessionResponse,
											done: true,
										})
									}
									let { promise, resolve } =
										createDeferred<IteratorResult<SessionResponse>>()
									readers.push(resolve)
									return promise
								},
							}
						},
					}
				},
			}
		},
	} as unknown as Driver

	return { driver, waitForNextStream }
}

// ── protocol response helpers ──────────────────────────────────────────────────

export let sessionStartedResponse = function sessionStartedResponse(
	sessionId: bigint
): SessionResponse {
	return {
		response: { case: 'sessionStarted', value: { sessionId } },
	} as unknown as SessionResponse
}

export let sessionStoppedResponse = function sessionStoppedResponse(): SessionResponse {
	return { response: { case: 'sessionStopped', value: {} } } as unknown as SessionResponse
}

// ── async helpers ──────────────────────────────────────────────────────────────

// Flush the microtask queue by chaining many Promise.resolve() ticks.
export let settle = async function settle(ticks = 100): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await Promise.resolve()
	}
}

// Yield to the macrotask queue (timers, I/O callbacks) once.
// Unlike Promise.resolve() microtasks, setImmediate yields between event loop
// phases so that pending setTimeout callbacks (retry backoff, recovery window)
// get a chance to fire before we resume.
export let tick = function tick(): Promise<void> {
	let deferred = createDeferred<void>()
	setTimeout(deferred.resolve, 0)
	return deferred.promise
}

// Poll until the session reaches the expected status, then run additional
// settle ticks so that async effects scheduled on that transition (such as
// finalizeRuntime) also have a chance to complete before assertions run.
//
// Uses setImmediate-based yields (not Promise microtasks) so that real timer
// callbacks (setTimeout for retryBackoff / recoveryWindow) can fire while we
// are waiting.
export let waitForStatus = async function waitForStatus(
	runtime: SessionRuntime,
	expected: SessionStatus,
	maxTicks = 1000
): Promise<void> {
	for (let i = 0; i < maxTicks; i++) {
		if (runtime.status === expected) {
			// Extra settle: the FSM state changes synchronously during dispatch but
			// the effects (e.g. markClosed → finalizeRuntime → signalController.abort)
			// run asynchronously.  Give them time to complete before returning.

			// oxlint-disable-next-line no-await-in-loop
			await settle()

			return
		}
		// oxlint-disable-next-line no-await-in-loop
		await tick()
	}
	if (runtime.status !== expected) {
		throw new Error(
			`Status "${expected}" not reached after ${maxTicks} ticks; current: "${runtime.status}"`
		)
	}
}
