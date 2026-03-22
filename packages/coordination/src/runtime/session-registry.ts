import type { SessionResponse } from '@ydbjs/api/coordination'

export type Deferred<T> = {
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
	reject(reason?: unknown): void
}

export class SessionReconnectError extends Error {
	constructor() {
		super('Session reconnecting')
		this.name = 'SessionReconnectError'
	}
}

export let createDeferred = function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	let promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})

	// Prevent UnhandledPromiseRejection when rejected before anyone awaits.
	promise.catch(() => {})

	return { promise, resolve, reject }
}

export class PendingRequest implements Disposable {
	#registry: SessionRequestRegistry
	#reqId: bigint

	promise: Promise<SessionResponse>
	resolve: (value: SessionResponse | PromiseLike<SessionResponse>) => void
	reject: (reason?: unknown) => void

	constructor(
		registry: SessionRequestRegistry,
		reqId: bigint,
		deferred: Deferred<SessionResponse>
	) {
		this.#registry = registry
		this.#reqId = reqId
		this.promise = deferred.promise
		this.resolve = deferred.resolve
		this.reject = deferred.reject
	}

	[Symbol.dispose](): void {
		this.#registry.delete(this.#reqId)
	}
}

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

	register(reqId: bigint): PendingRequest {
		if (this.#closed || this.#destroyed) {
			throw new Error('Session request registry is closed')
		}

		let deferred = createDeferred<SessionResponse>()
		let pending = new PendingRequest(this, reqId, deferred)

		this.#pending.set(reqId, pending)

		return pending
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

	reconnect(): void {
		if (this.#closed || this.#destroyed) {
			return
		}

		for (let [, pending] of this.#pending) {
			pending.reject(new SessionReconnectError())
		}

		this.#pending.clear()
	}

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
