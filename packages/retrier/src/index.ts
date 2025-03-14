import type { RetryConfig } from "./config.js";
import type { RetryContext } from "./context.js";

const defaultConfig: Required<RetryConfig> = {
    idempotent: true,
    retry: (error) => error instanceof Error,
    budget: Number.POSITIVE_INFINITY,
    strategy: (ctx) => ctx.attempt * 100,
}

export async function retry<R>(fn: () => R | Promise<R>, cfg: RetryConfig = defaultConfig): Promise<R> {
    let config = Object.assign({}, defaultConfig, cfg)
    let ctx: RetryContext = { attempt: 0, error: null };

    let budget: number
    while (ctx.attempt < (budget = (typeof config.budget === "number" ? config.budget : config.budget(ctx, config)))) {
        try {
            return await fn();
        } catch (error) {
            ctx = { attempt: ctx.attempt + 1, error };
            if (!config.retry(error) || ctx.attempt >= budget) {
                throw error;
            }

            const delay = typeof config.strategy === "number" ? config.strategy : config.strategy(ctx, config);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    let error = new Error('Retry budget exceeded')
    Object.assign(error, {
        [Symbol.for('retriable')]: false,
    })

    throw error;
}

export * from './config.js'
export * from './context.js'
