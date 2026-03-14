import type { CoordinationSession } from './session.js'
import { loggers } from '@ydbjs/debug'
import { getSessionRuntime } from './internal/session-runtime.js'
import { isTryAcquireMiss } from './internal/try-acquire.js'

// Passing MAX_UINT64 as timeoutMillis tells the server to keep the acquire
// request in the waiters queue indefinitely.  timeoutMillis: 0 means "return
// immediately if not available", which is tryAcquire semantics — not acquire.
let waitIndefinitely = 2n ** 64n - 1n

let dbg = loggers.coordination.extend('semaphore')
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

		dbg.log('releasing lease on %s', this.#name)
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
		dbg.log('creating %s (limit=%s)', this.#name, options.limit)
		return this.#runtime.createSemaphore(
			this.#name,
			{ ...options, limit: toCount(options.limit) },
			signal
		)
	}

	update(data: Uint8Array, signal?: AbortSignal): Promise<void> {
		dbg.log('updating data on %s (%d bytes)', this.#name, data.byteLength)
		return this.#runtime.updateSemaphore(this.#name, data, signal)
	}

	delete(options?: DeleteSemaphoreOptions, signal?: AbortSignal): Promise<void> {
		dbg.log('deleting %s%s', this.#name, options?.force ? ' (force)' : '')
		return this.#runtime.deleteSemaphore(this.#name, options, signal)
	}

	async acquire(options?: AcquireSemaphoreOptions, signal?: AbortSignal): Promise<Lease> {
		dbg.log('waiting to acquire %s (count=%s)', this.#name, options?.count ?? 1)
		let lease = await this.#runtime.acquireSemaphore(
			this.#name,
			normalizeAcquireOptions({ waitTimeout: waitIndefinitely, ...options }),
			signal
		)
		dbg.log('acquired %s', this.#name)
		return new Lease(this.#name, lease)
	}

	async tryAcquire(
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<Lease | null> {
		// Force waitTimeout to 0 so the server returns immediately instead of
		// blocking — the caller gets null rather than waiting indefinitely.
		let normalized = normalizeAcquireOptions({ ...options, waitTimeout: 0n })

		dbg.log('trying to acquire %s without waiting (count=%s)', this.#name, options?.count ?? 1)
		try {
			let lease = await this.#runtime.acquireSemaphore(this.#name, normalized, signal)
			dbg.log('acquired %s', this.#name)
			return new Lease(this.#name, lease)
		} catch (error) {
			if (isTryAcquireMiss(error)) {
				dbg.log('%s is already held, skipping', this.#name)
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
