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
		let reservedAt: number
		if (now >= this.#next) {
			reservedAt = now
		} else {
			reservedAt = this.#next
		}
		this.#next = reservedAt + this.#intervalMs

		let delay = reservedAt - now
		if (delay > 0) await sleep(delay, undefined, { signal })
	}
}
