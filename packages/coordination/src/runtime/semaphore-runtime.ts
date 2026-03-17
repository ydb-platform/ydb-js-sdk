let maxUint64 = 2n ** 64n - 1n
let emptyBytes = new Uint8Array()

export let toCount = function toCount(value?: number | bigint, fallback = 1n): bigint {
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

export interface CreateSemaphoreOptions {
	data?: Uint8Array
	limit: number | bigint
}

export interface DeleteSemaphoreOptions {
	force?: boolean
}

export interface AcquireSemaphoreOptions {
	data?: Uint8Array
	count?: number | bigint
	ephemeral?: boolean
	waitTimeout?: number | bigint
}

// Normalized form where all numeric fields have been coerced to bigint.
// This is what the runtime layer works with after the public API layer calls
// normalizeAcquireOptions().
export interface NormalizedAcquireOptions {
	data: Uint8Array
	count: bigint
	ephemeral: boolean
	waitTimeout: bigint
}

export let normalizeAcquireOptions = function normalizeAcquireOptions(
	options?: AcquireSemaphoreOptions
): NormalizedAcquireOptions {
	return {
		data: options?.data ?? emptyBytes,
		count: toCount(options?.count, 1n),
		ephemeral: options?.ephemeral ?? false,
		waitTimeout: toCount(options?.waitTimeout, 0n),
	}
}

export interface DescribeSemaphoreOptions {
	owners?: boolean
	waiters?: boolean
}

export interface WatchSemaphoreOptions extends DescribeSemaphoreOptions {
	data?: boolean
}

export interface SemaphoreSessionDescription {
	data: Uint8Array
	count: bigint
	orderId: bigint
	sessionId: bigint
	timeoutMillis: bigint
}

export interface SemaphoreDescription {
	name: string
	data: Uint8Array
	count: bigint
	limit: bigint
	ephemeral: boolean
	owners?: SemaphoreSessionDescription[]
	waiters?: SemaphoreSessionDescription[]
}

export interface LeaseRuntime {
	readonly signal: AbortSignal

	release(signal?: AbortSignal): Promise<void>
}

export interface SemaphoreRuntime {
	readonly signal: AbortSignal

	createSemaphore(
		name: string,
		options: CreateSemaphoreOptions,
		signal?: AbortSignal
	): Promise<void>

	updateSemaphore(name: string, data: Uint8Array, signal?: AbortSignal): Promise<void>

	deleteSemaphore(
		name: string,
		options?: DeleteSemaphoreOptions,
		signal?: AbortSignal
	): Promise<void>

	acquireSemaphore(
		name: string,
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<LeaseRuntime>

	describeSemaphore(
		name: string,
		options?: DescribeSemaphoreOptions,
		signal?: AbortSignal
	): Promise<SemaphoreDescription>

	watchSemaphore(
		name: string,
		options?: WatchSemaphoreOptions,
		signal?: AbortSignal
	): AsyncIterable<SemaphoreDescription>
}
