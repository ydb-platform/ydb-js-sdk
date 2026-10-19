export function abortable<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
	if (!signal) {
		return promise
	}
	if (signal.aborted) {
		void promise.catch(() => {})
		return Promise.reject(signal.reason)
	}

	let abortHandler: () => void
	let abortPromise = new Promise<T>((_, reject) => {
		abortHandler = () => reject(signal.reason)
		signal.addEventListener('abort', abortHandler, { once: true })
	})

	return Promise.race([promise, abortPromise]).finally(() => {
		signal.removeEventListener('abort', abortHandler)
	})
}
