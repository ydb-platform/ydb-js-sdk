export async function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
	if (signal.aborted) {
		throw new DOMException('AbortError', { name: 'AbortError', cause: signal.reason })
	}

	let abortHandler: () => void

	return Promise.race<T>([
		promise,
		new Promise((_, reject) => {
			let reason = new DOMException('AbortError', { name: 'AbortError', cause: signal.reason })
			abortHandler = () => reject(reason)
			signal.addEventListener('abort', abortHandler, { once: true })
		}),
	])
		.finally(() => {
			signal.removeEventListener('abort', abortHandler)
		})
}
