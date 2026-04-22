import { RateLimiter } from './rate-limiter.ts'

export type WorkerData = {
	name: string
	params: Record<string, string>
}

export type ControlMessage = { type: 'stop' }
export const CONTROL_CHANNEL = 'slo-workload-control'

// Aborts the given controller when a 'stop' message is received on the control channel.
export function abortOnStop(ctrl: AbortController): Disposable {
	let ch = new BroadcastChannel(CONTROL_CHANNEL)
	ch.addEventListener('message', (ev) => {
		if (ev.data?.type === 'stop') {
			ctrl.abort()
		}
	})

	return {
		[Symbol.dispose]() {
			ch.close()
		},
	}
}

// Run `op` with rate limiting to `rps` per second, aborting on `signal`.
// `maxConcurrency` caps in-flight ops so slow ops can't accumulate unboundedly.
export async function runPaced(
	rps: number,
	op: () => Promise<void>,
	signal: AbortSignal,
	maxConcurrency = rps * 2
): Promise<void> {
	let limiter = new RateLimiter(rps)
	let inflight = new Set<Promise<void>>()
	while (!signal.aborted) {
		if (inflight.size >= maxConcurrency) {
			// oxlint-disable-next-line no-await-in-loop
			await Promise.race(inflight)
		}
		try {
			// oxlint-disable-next-line no-await-in-loop
			await limiter.wait(signal)
		} catch {
			break
		}
		let p = op().finally(() => inflight.delete(p))
		inflight.add(p)
	}
	await Promise.allSettled(inflight)
}
