// Sentinel error thrown by acquireSemaphore when a non-blocking acquire attempt
// finds no available tokens (waitTimeout: 0 and the semaphore is fully held).
// Using a dedicated class instead of string-matching makes detection reliable
// and immune to message wording changes or localisation differences.
export class TryAcquireMissError extends Error {
	constructor() {
		super('Try-acquire miss: semaphore has no available tokens')
		this.name = 'TryAcquireMissError'
	}
}

// Convenience predicate used by Semaphore.tryAcquire and Mutex.tryLock so
// callers can check with a single function rather than an instanceof expression.
export let isTryAcquireMiss = function isTryAcquireMiss(error: unknown): boolean {
	return error instanceof TryAcquireMissError
}
