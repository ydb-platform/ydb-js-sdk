import type { Abortable } from 'node:events'

import type { RetryBudget } from './budget.js'
import type { RetryContext } from './context.js'
import type { RetryStrategy } from './strategy.js'

export interface RetryHooks {
	/**
	 * Wraps the entire retry loop.
	 * Use this to establish a parent span and run all attempts within its context.
	 */
	wrapRun?: <T>(fn: () => Promise<T>) => Promise<T>

	/**
	 * Wraps each individual attempt.
	 * Use this to establish a per-attempt span and run the attempt within its context.
	 */
	wrapAttempt?: <T>(ctx: RetryContext, fn: () => T) => T

	/** Called when an attempt completes successfully. */
	onAttemptSuccess?: (ctx: RetryContext) => void

	/**
	 * Called when an attempt fails.
	 * @param backoffMs - delay before the next attempt; 0 means no retry or no delay.
	 */
	onAttemptError?: (ctx: RetryContext, error: unknown, backoffMs: number) => void
}

export interface RetryConfig extends Abortable, RetryHooks {
	/** Predicate to determine if an error is retryable */
	retry?: boolean | ((error: RetryContext['error'], idempotent: boolean) => boolean)
	/** Budget for retry attempts */
	budget?: number | RetryBudget
	/** Strategy to calculate delay */
	strategy?: number | RetryStrategy
	/** Idempotent operation */
	idempotent?: boolean

	/** Hook to be called before retrying */
	onRetry?: (ctx: RetryContext) => void
}
