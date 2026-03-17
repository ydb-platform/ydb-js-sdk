import { setTimeout } from 'timers/promises'

import { abortable, linkSignals } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { loggers } from '@ydbjs/debug'
import { CommitError, YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'

import type { RetryConfig } from './config.js'
import type { RetryContext } from './context.js'
import { type RetryStrategy, backoff, fixed } from './strategy.js'

export * from './config.js'
export * from './context.js'
export * as strategies from './strategy.js'

const BACKOFF_OVERLOAD_BASE_MS = 1000
const BACKOFF_OVERLOAD_MAX_MS = 60_000
const BACKOFF_DEFAULT_BASE_MS = 10
const BACKOFF_DEFAULT_MAX_MS = 30_000

let dbg = loggers.retry

export async function retry<R>(
	cfg: RetryConfig,
	fn: (signal: AbortSignal) => R | Promise<R>
): Promise<R> {
	let config = Object.assign({}, defaultRetryConfig, cfg)
	let ctx: RetryContext = { attempt: 0, error: null }

	let budget: number
	while (
		ctx.attempt <
		(budget = typeof config.budget === 'number' ? config.budget : config.budget!(ctx, config))
	) {
		let ac = new AbortController()
		using linkedSignal = linkSignals(cfg.signal, ac.signal)

		let start = Date.now()
		let signal = linkedSignal.signal

		try {
			signal.throwIfAborted()
			dbg.log('attempt %d: calling retry function', ctx.attempt + 1)
			// oxlint-disable-next-line no-await-in-loop
			let result = await abortable(signal, Promise.resolve(fn(signal)))
			dbg.log('attempt %d: success', ctx.attempt + 1)
			return result
		} catch (error) {
			ctx.error = error
			ctx.attempt += 1

			if (error instanceof Error && error.name === 'AbortError') {
				dbg.log('attempt %d: abort error, not retryable', ctx.attempt)
				throw error
			}

			if (error instanceof Error && error.name === 'TimeoutError') {
				dbg.log('attempt %d: timeout error, not retryable', ctx.attempt)
				throw error
			}

			let willRetry: boolean
			if (typeof config.retry === 'boolean') {
				willRetry = config.retry
			} else {
				willRetry = config.retry?.(ctx.error, cfg.idempotent ?? false) ?? false
			}

			if (!willRetry || ctx.attempt >= budget) {
				dbg.log('attempt %d: not retrying, error: %O', ctx.attempt, error)
				break
			}

			let delay: number
			if (typeof config.strategy === 'number') {
				delay = config.strategy
			} else {
				delay = config.strategy?.(ctx, config) ?? 0
			}

			let remaining = Math.max(delay - (Date.now() - start), 0)
			if (!remaining) {
				dbg.log('attempt %d: no delay before next retry', ctx.attempt)
				continue
			}

			dbg.log('attempt %d: waiting %d ms before next retry', ctx.attempt, remaining)
			// oxlint-disable no-await-in-loop
			await setTimeout(remaining, void 0, { signal })

			if (config.onRetry) {
				config.onRetry(ctx)
			}
		} finally {
			ac.abort('Retry cancelled')
		}
	}

	dbg.log('retry failed after %d attempts, last error: %O', ctx.attempt, ctx.error)
	throw ctx.error
}

export function isRetryableError(error: unknown, idempotent = false): boolean {
	if (error instanceof ClientError) {
		return (
			error.code === Status.ABORTED ||
			error.code === Status.INTERNAL ||
			error.code === Status.RESOURCE_EXHAUSTED ||
			(error.code === Status.UNAVAILABLE && idempotent)
		)
	}

	if (error instanceof YDBError) {
		return error.retryable === true || (error.retryable === 'conditionally' && idempotent)
	}

	if (error instanceof CommitError) {
		return error.retryable(idempotent)
	}

	return false
}

/**
 * Determines whether an error from a long-lived gRPC stream should trigger
 * a reconnect attempt.
 *
 * Streaming RPCs differ from unary calls: a CANCELLED or UNAVAILABLE status
 * means the transport was interrupted (e.g. the server restarted, the
 * connection pool was refreshed after a discovery round), not that the
 * *operation* was semantically cancelled by the caller.  We therefore always
 * reconnect on those codes, in addition to the errors handled by
 * {@link isRetryableError}.
 */
export function isRetryableStreamError(error: unknown): boolean {
	if (error instanceof ClientError) {
		return (
			error.code === Status.CANCELLED ||
			error.code === Status.UNAVAILABLE ||
			isRetryableError(error, true)
		)
	}

	return isRetryableError(error, false)
}

export const defaultRetryConfig: RetryConfig = {
	retry: isRetryableError,
	budget: Infinity,
	strategy: (ctx, cfg) => {
		if (ctx.error instanceof YDBError && ctx.error.code === StatusIds_StatusCode.BAD_SESSION) {
			return fixed(0)(ctx, cfg)
		}

		if (
			ctx.error instanceof YDBError &&
			ctx.error.code === StatusIds_StatusCode.SESSION_EXPIRED
		) {
			return fixed(0)(ctx, cfg)
		}

		if (ctx.error instanceof ClientError && ctx.error.code === Status.ABORTED) {
			return fixed(0)(ctx, cfg)
		}

		if (ctx.error instanceof YDBError && ctx.error.code === StatusIds_StatusCode.OVERLOADED) {
			return backoff(BACKOFF_OVERLOAD_BASE_MS, BACKOFF_OVERLOAD_MAX_MS)(ctx, cfg)
		}

		if (ctx.error instanceof ClientError && ctx.error.code === Status.RESOURCE_EXHAUSTED) {
			return backoff(BACKOFF_OVERLOAD_BASE_MS, BACKOFF_OVERLOAD_MAX_MS)(ctx, cfg)
		}

		return backoff(BACKOFF_DEFAULT_BASE_MS, BACKOFF_DEFAULT_MAX_MS)(ctx, cfg)
	},
}

/**
 * Default retry configuration for long-lived gRPC streaming connections
 * (topic reader / writer).
 *
 * Extends {@link defaultRetryConfig} with reconnect logic for transient
 * transport errors ({@link isRetryableStreamError}).
 */
export const defaultStreamRetryConfig: RetryConfig = {
	...defaultRetryConfig,
	retry: isRetryableStreamError,
	strategy: (ctx, cfg) => {
		if (
			ctx.error instanceof ClientError &&
			(ctx.error.code === Status.CANCELLED || ctx.error.code === Status.UNAVAILABLE)
		) {
			return backoff(BACKOFF_DEFAULT_BASE_MS, BACKOFF_DEFAULT_MAX_MS)(ctx, cfg)
		}

		return (defaultRetryConfig.strategy as RetryStrategy)(ctx, cfg)
	},
}
