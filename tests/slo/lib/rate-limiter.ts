import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'

export class RateLimiter {
	#next = 0
	readonly #intervalMs: number

	constructor(rps: number) {
		this.#intervalMs = rps > 0 ? 1000 / rps : 0
	}

	async wait(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		if (this.#intervalMs === 0) return

		let now = performance.now()
		// Recover timer overshoot without replaying an unbounded backlog after a pause.
		let reservedAt = Math.max(this.#next, now - this.#intervalMs)
		this.#next = reservedAt + this.#intervalMs

		let delay = reservedAt - now
		if (delay > 0) await sleep(delay, undefined, { signal })
	}
}
