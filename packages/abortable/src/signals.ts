export interface LinkedSignal extends Disposable {
	signal: AbortSignal
}

export function linkSignals(...signals: (AbortSignal | undefined)[]): LinkedSignal {
	let ac = new AbortController()
	let activeSignals = signals.filter((s): s is AbortSignal => !!s)

	for (let signal of activeSignals) {
		if (signal.aborted) {
			ac.abort(signal.reason)

			return {
				signal: ac.signal,
				[Symbol.dispose]: () => {},
			}
		}
	}

	let onAbort = (e: Event) => ac.abort((e.target as AbortSignal).reason)

	for (let signal of activeSignals) {
		signal.addEventListener('abort', onAbort, { once: true })
	}

	return {
		signal: ac.signal,
		[Symbol.dispose]() {
			for (let signal of activeSignals) {
				signal.removeEventListener('abort', onAbort)
			}

			if (!ac.signal.aborted) {
				ac.abort()
			}
		},
	}
}
