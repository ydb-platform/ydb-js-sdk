import type { CoordinationSession } from './session.js'
import { getSessionRuntime } from './internal/session-runtime.js'
import { isTryAcquireMiss } from './internal/try-acquire.js'
import {
	type AcquireSemaphoreOptions,
	type CreateSemaphoreOptions,
	type DeleteSemaphoreOptions,
	type DescribeSemaphoreOptions,
	type LeaseRuntime,
	type SemaphoreDescription,
	type SemaphoreRuntime,
	type WatchSemaphoreOptions,
	normalizeAcquireOptions,
	toCount,
} from './runtime/semaphore-runtime.js'

export type {
	AcquireSemaphoreOptions,
	CreateSemaphoreOptions,
	DeleteSemaphoreOptions,
	DescribeSemaphoreOptions,
	SemaphoreDescription,
	WatchSemaphoreOptions,
} from './runtime/semaphore-runtime.js'

export interface SemaphoreSessionDescription {
	data: Uint8Array
	count: bigint
	orderId: bigint
	sessionId: bigint
	timeoutMillis: bigint
}

export class Lease implements AsyncDisposable {
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

		this.#released = true
		await this.#runtime.release(signal)
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.release()
	}
}

export class Semaphore {
	#name: string
	#runtime: SemaphoreRuntime

	constructor(session: CoordinationSession, name: string) {
		this.#name = name
		this.#runtime = getSessionRuntime(session)
	}

	get name(): string {
		return this.#name
	}

	create(options: CreateSemaphoreOptions, signal?: AbortSignal): Promise<void> {
		return this.#runtime.createSemaphore(
			this.#name,
			{ ...options, limit: toCount(options.limit) },
			signal
		)
	}

	update(data: Uint8Array, signal?: AbortSignal): Promise<void> {
		return this.#runtime.updateSemaphore(this.#name, data, signal)
	}

	delete(options?: DeleteSemaphoreOptions, signal?: AbortSignal): Promise<void> {
		return this.#runtime.deleteSemaphore(this.#name, options, signal)
	}

	async acquire(options?: AcquireSemaphoreOptions, signal?: AbortSignal): Promise<Lease> {
		let lease = await this.#runtime.acquireSemaphore(
			this.#name,
			normalizeAcquireOptions(options),
			signal
		)
		return new Lease(this.#name, lease)
	}

	async tryAcquire(
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<Lease | null> {
		// Force waitTimeout to 0 so the server returns immediately instead of
		// blocking — the caller gets null rather than waiting indefinitely.
		let normalized = normalizeAcquireOptions({ ...options, waitTimeout: 0n })

		try {
			let lease = await this.#runtime.acquireSemaphore(this.#name, normalized, signal)
			return new Lease(this.#name, lease)
		} catch (error) {
			if (isTryAcquireMiss(error)) {
				return null
			}

			throw error
		}
	}

	describe(
		options?: DescribeSemaphoreOptions,
		signal?: AbortSignal
	): Promise<SemaphoreDescription> {
		return this.#runtime.describeSemaphore(this.#name, options, signal)
	}

	watch(
		options?: WatchSemaphoreOptions,
		signal?: AbortSignal
	): AsyncIterable<SemaphoreDescription> {
		return this.#runtime.watchSemaphore(this.#name, options, signal)
	}
}
