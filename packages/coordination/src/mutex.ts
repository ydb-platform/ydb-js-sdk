import type { CoordinationSession } from './session.js'
import { getSessionRuntime } from './internal/session-runtime.js'
import { isTryAcquireMiss } from './internal/try-acquire.js'
import type { LeaseRuntime } from './runtime/semaphore-runtime.js'
import type { SessionRuntime } from './runtime/session-runtime.js'

let mutexCapacity = 2n ** 64n - 1n

export class Lock implements AsyncDisposable {
	#name: string
	#runtime: LeaseRuntime
	#released = false

	constructor(name: string, runtime: LeaseRuntime) {
		this.#name = name
		this.#runtime = runtime
	}

	get name(): string {
		return this.#name
	}

	get signal(): AbortSignal {
		return this.#runtime.signal
	}

	async release(signal?: AbortSignal): Promise<void> {
		if (this.#released) {
			return
		}

		await this.#runtime.release(signal)
		this.#released = true
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.release()
	}
}

export class Mutex {
	#name: string
	#runtime: SessionRuntime

	constructor(session: CoordinationSession, name: string) {
		this.#name = name
		this.#runtime = getSessionRuntime(session)
	}

	get name(): string {
		return this.#name
	}

	async lock(signal?: AbortSignal): Promise<Lock> {
		await this.#ensureSemaphore(signal)

		let lease = await this.#runtime.acquireSemaphore(
			this.#name,
			{ count: mutexCapacity },
			signal
		)

		return new Lock(this.#name, lease)
	}

	async tryLock(signal?: AbortSignal): Promise<Lock | null> {
		await this.#ensureSemaphore(signal)

		try {
			let lease = await this.#runtime.acquireSemaphore(
				this.#name,
				{
					count: mutexCapacity,
					waitTimeout: 0,
				},
				signal
			)

			return new Lock(this.#name, lease)
		} catch (error) {
			if (isTryAcquireMiss(error)) {
				return null
			}

			throw error
		}
	}

	async #ensureSemaphore(signal?: AbortSignal): Promise<void> {
		try {
			await this.#runtime.createSemaphore(
				this.#name,
				{
					limit: mutexCapacity,
				},
				signal
			)
			return
		} catch {
			let description = await this.#runtime.describeSemaphore(this.#name, undefined, signal)
			if (description.limit !== mutexCapacity) {
				throw new Error('Mutex semaphore has incompatible limit')
			}
		}
	}
}

export let createMutex = function createMutex(session: CoordinationSession, name: string): Mutex {
	return new Mutex(session, name)
}
