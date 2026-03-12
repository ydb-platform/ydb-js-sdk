// Detects errors that indicate a non-blocking acquire attempt found no available
// tokens — meaning the caller should return null rather than propagate the error.
// Both Semaphore.tryAcquire and Mutex.tryLock rely on this check.
export let isTryAcquireMiss = function isTryAcquireMiss(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false
	}

	let message = error.message.toLowerCase()

	return (
		message.includes('timeout') ||
		message.includes('not acquired') ||
		message.includes('would block') ||
		message.includes('try acquire miss')
	)
}
