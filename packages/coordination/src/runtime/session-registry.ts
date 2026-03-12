import type { SessionResponse } from '@ydbjs/api/coordination'

export type Deferred<T> = {
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
	reject(reason?: unknown): void
}

// A retryable error dispatched to all in-flight requests when the session
// enters reconnecting.  The request() loop catches this specific type and
// re-waits for ready before re-sending — all other errors are propagated.
export class SessionReconnectError extends Error {
	constructor() {
		super('Session reconnecting')
		this.name = 'SessionReconnectError'
	}
}

export let createDeferred = function createDeferred<T>(): Deferred<T> {
	let promise = Promise.withResolvers<T>()

	// Attach a no-op catch so that if the deferred is rejected while nobody is
	// awaiting it (e.g. before the first waitReady() call), Node.js does not
	// raise an UnhandledPromiseRejection.  Callers that do await the promise
	// still receive the rejection normally through their own chain.
	promise.promise.catch(() => {})

	return {
		promise: promise.promise,
		resolve: promise.resolve,
		reject: promise.reject,
	}
}

type PendingRequest = {
	resolve(response: SessionResponse): void
	reject(reason?: unknown): void
}

// Tracks all requests that have been sent on the wire and are waiting for a
// matching server response.  Each request is keyed by its wire-level reqId.
//
// Lifecycle:
//   reconnect() — called when the session enters reconnecting; rejects every
//                 pending request with SessionReconnectError so the callers
//                 can loop back through waitReady() and re-send.
//   close()     — called when a graceful SessionStop is sent; rejects
//                 remaining requests and prevents new ones from registering.
//   destroy()   — called on forced close or expiry; same as close() but also
//                 blocks nextReqId() and uses the caller-supplied reason.
export class SessionRequestRegistry implements Disposable {
	#nextReqId = 1n
	#closed = false
	#destroyed = false
	#pending = new Map<bigint, PendingRequest>()

	nextReqId(): bigint {
		if (this.#closed || this.#destroyed) {
			throw new Error('Session request registry is closed')
		}

		let reqId = this.#nextReqId
		this.#nextReqId += 1n

		return reqId
	}

	register(reqId: bigint): Deferred<SessionResponse> {
		if (this.#closed || this.#destroyed) {
			throw new Error('Session request registry is closed')
		}

		let deferred = createDeferred<SessionResponse>()

		this.#pending.set(reqId, {
			resolve: deferred.resolve,
			reject: deferred.reject,
		})

		return deferred
	}

	delete(reqId: bigint): void {
		this.#pending.delete(reqId)
	}

	resolve(reqId: bigint, response: SessionResponse): boolean {
		let pending = this.#pending.get(reqId)
		if (!pending) {
			return false
		}

		this.#pending.delete(reqId)
		pending.resolve(response)

		return true
	}

	// Reject every pending request with a retryable error so the callers loop
	// back to waitReady() and re-send after the session reconnects.
	reconnect(): void {
		if (this.#closed || this.#destroyed) {
			return
		}

		for (let [, pending] of this.#pending) {
			pending.reject(new SessionReconnectError())
		}

		this.#pending.clear()
	}

	// Reject pending requests and block new registrations.  Called when
	// session.close is dispatched — new requests must not be sent after this.
	close(): void {
		if (this.#closed || this.#destroyed) {
			return
		}

		this.#closed = true

		for (let [, pending] of this.#pending) {
			pending.reject(new Error('Session closed'))
		}

		this.#pending.clear()
	}

	// Reject pending requests with an arbitrary reason and permanently seal
	// both nextReqId() and register().  Called on forced destroy or expiry.
	destroy(reason: unknown): void {
		if (this.#destroyed) {
			return
		}

		this.#destroyed = true
		this.#closed = true

		for (let [, pending] of this.#pending) {
			pending.reject(reason)
		}

		this.#pending.clear()
	}

	[Symbol.dispose](): void {
		this.destroy(new Error('Session request registry disposed'))
	}
}
