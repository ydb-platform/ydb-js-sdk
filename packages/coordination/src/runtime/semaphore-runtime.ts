export interface CreateSemaphoreOptions {
	data?: Uint8Array
	limit: number | bigint
}

export interface UpdateSemaphoreOptions {
	data?: Uint8Array
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

	updateSemaphore(
		name: string,
		options: UpdateSemaphoreOptions,
		signal?: AbortSignal
	): Promise<void>

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
