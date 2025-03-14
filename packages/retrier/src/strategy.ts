import type { RetryConfig } from "./config.js";
import type { RetryContext } from "./context.js";

/**
 * Strategy to calculate delay.
 * @param ctx - Context for retry operation
 * @param cfg - Options for retry configuration
 * @returns Delay in milliseconds
 *
 * @example
 * ```ts
 * import { retry, fixed } from '@ydbjs/retrier'
 *
 * await retry(() => fetch('https://example.com'), {
 *     strategy: fixed(1000),
 * })
 * ```
 */
export interface RetryStrategy {
    (ctx: RetryContext, cfg: RetryConfig): number;
}

export function fixed(ms: number): RetryStrategy {
    return () => ms
}

export function linear(ms: number): RetryStrategy {
    return (ctx) => ctx.attempt * ms
}

export function exponential(ms: number): RetryStrategy {
    return (ctx) => Math.pow(2, ctx.attempt) * ms
}

export function random(min: number, max: number): RetryStrategy {
    return () => Math.floor(Math.random() * (max - min + 1) + min)
}

export function jitter(ms: number): RetryStrategy {
    return (ctx) => Math.floor(Math.random() * ms) + ctx.attempt
}

export function backoff(base: number, max: number): RetryStrategy {
    return (ctx) => Math.min(Math.pow(2, ctx.attempt) * base, max)
}

export function limit(max: number): RetryStrategy {
    return (ctx) => Math.min(ctx.attempt, max)
}

export function combine(...strategies: RetryStrategy[]): RetryStrategy {
    return (ctx, cfg) => strategies.reduce((acc, strategy) => acc + strategy(ctx, cfg), 0)
}

export function compose(...strategies: RetryStrategy[]): RetryStrategy {
    return (ctx, cfg) => strategies.reduce((acc, strategy) => Math.max(acc, strategy(ctx, cfg)), 0)
}
