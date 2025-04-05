import type { RetryConfig } from './config.js'
import type { RetryContext } from './context.js'
import { linear } from './strategy.js'

export const defaultRetryConfig: RetryConfig = {
	retry: (error) => error instanceof Error,
	budget: Number.POSITIVE_INFINITY,
	strategy: linear(100),
	idempotent: true,
}

export async function retry<R>(cfg: RetryConfig, fn: () => R | Promise<R>): Promise<R> {
	let config = Object.assign({}, defaultRetryConfig, cfg)
	let ctx: RetryContext = { attempt: 0, error: null }

	let budget: number
	while (ctx.attempt < (budget = typeof config.budget === 'number' ? config.budget : config.budget!(ctx, config))) {
		let start = Date.now()
		if (cfg.signal?.aborted) {
			throw cfg.signal.reason
		}

		try {
			return fn()
		} catch (error) {
			ctx.attempt += 1
			ctx.error = error

			let retry = typeof config.retry === 'function' ? config.retry(ctx.error) : config.retry
			if (!retry || ctx.attempt >= budget) {
				throw error
			}

			let delay = typeof config.strategy === 'number' ? config.strategy : config.strategy!(ctx, config)
			let remaining = Math.max(delay - (Date.now() - start), 0)
			if (!remaining) {
				continue
			}

			if (cfg.signal?.aborted) {
				throw cfg.signal.reason
			}

			// oxlint-disable no-await-in-loop
			await Promise.race([
				new Promise((resolve) => setTimeout(resolve, remaining)),
				new Promise((_, reject) => {
					let signal = cfg.signal
					if (signal) {
						signal.addEventListener('abort', function abortHandler() {
							reject(signal.reason)
							signal.removeEventListener('abort', abortHandler)
						})
					}
				}),
			])
		}
	}

	throw new Error('Retry budget exceeded')
}

export * from './config.js'
export * from './context.js'
