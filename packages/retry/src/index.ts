import type { RetryConfig } from "./config.js";
import type { RetryContext } from "./context.js";

export const defaultRetryConfig: Required<RetryConfig> = {
	retry: (error) => error instanceof Error,
	budget: Number.POSITIVE_INFINITY,
	strategy: (ctx) => ctx.attempt * 100,
	idempotent: true,
}

export async function retry<R>(cfg: RetryConfig, fn: () => R | Promise<R>): Promise<R> {
	let config = Object.assign({}, defaultRetryConfig, cfg)
	let ctx: RetryContext = { attempt: 0, error: null };

	let budget: number
	while (ctx.attempt < (budget = (typeof config.budget === "number" ? config.budget : config.budget(ctx, config)))) {
		try {
			return await fn();
		} catch (error) {
			ctx.attempt += 1
			ctx.error = error

			let retry = typeof config.retry === 'function' ? config.retry(ctx.error) : config.retry
			if (!retry || ctx.attempt >= budget) {
				throw error;
			}

			const delay = typeof config.strategy === "number" ? config.strategy : config.strategy(ctx, config);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw new Error('Retry budget exceeded')
}

export * from './config.js'
export * from './context.js'
