import type { CoordinationSession } from './session.js'
import { getSessionRuntime } from './internal/session-runtime.js'
import { isTryAcquireMiss } from './internal/try-acquire.js'
import type {
	AcquireSemaphoreOptions,
	CreateSemaphoreOptions,
	DeleteSemaphoreOptions,
	DescribeSemaphoreOptions,
	LeaseRuntime,
	SemaphoreDescription,
	SemaphoreRuntime,
	UpdateSemaphoreOptions,
	WatchSemaphoreOptions,
} from './runtime/semaphore-runtime.js'

export type {
	AcquireSemaphoreOptions,
	CreateSemaphoreOptions,
	DeleteSemaphoreOptions,
	DescribeSemaphoreOptions,
	SemaphoreDescription,
	UpdateSemaphoreOptions,
	WatchSemaphoreOptions,
} from './runtime/semaphore-runtime.js'

export interface SemaphoreSessionDescription {
	data: Uint8Array
	count: bigint
	orderId: bigint
	sessionId: bigint
	timeoutMillis: bigint
}

let emptyBytes = new Uint8Array()
let maxUint64 = 2n ** 64n - 1n

let toCount = function toCount(value?: number | bigint, fallback = 1n): bigint {
	if (value === undefined) {
		return fallback
	}

	if (typeof value === 'bigint') {
		return value
	}

	if (value === Infinity) {
		return maxUint64
	}

	return BigInt(value)
}

export let normalizeAcquireSemaphoreOptions = function normalizeAcquireSemaphoreOptions(
	options?: AcquireSemaphoreOptions
): Required<AcquireSemaphoreOptions> {
	return {
		data: options?.data ?? emptyBytes,
		count: toCount(options?.count, 1n),
		ephemeral: options?.ephemeral ?? false,
		waitTimeout: toCount(options?.waitTimeout, 0n),
	}
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

	update(options: UpdateSemaphoreOptions, signal?: AbortSignal): Promise<void> {
		return this.#runtime.updateSemaphore(this.#name, options, signal)
	}

	delete(options?: DeleteSemaphoreOptions, signal?: AbortSignal): Promise<void> {
		return this.#runtime.deleteSemaphore(this.#name, options, signal)
	}

	async acquire(options?: AcquireSemaphoreOptions, signal?: AbortSignal): Promise<Lease> {
		let normalizedOptions: AcquireSemaphoreOptions | undefined

		if (options) {
			normalizedOptions = {
				...options,
			}

			if (options.count !== undefined) {
				normalizedOptions.count = toCount(options.count)
			}

			if (options.waitTimeout !== undefined) {
				normalizedOptions.waitTimeout = toCount(options.waitTimeout, 0n)
			}
		}

		let lease = await this.#runtime.acquireSemaphore(this.#name, normalizedOptions, signal)
		return new Lease(this.#name, lease)
	}

	async tryAcquire(
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<Lease | null> {
		let nextOptions: AcquireSemaphoreOptions = {
			...options,
			waitTimeout: options?.waitTimeout === undefined ? 0n : toCount(options.waitTimeout, 0n),
		}

		if (options?.count !== undefined) {
			nextOptions.count = toCount(options.count)
		}

		try {
			let lease = await this.#runtime.acquireSemaphore(this.#name, nextOptions, signal)
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
