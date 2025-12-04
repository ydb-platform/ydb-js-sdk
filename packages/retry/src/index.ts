import { setTimeout } from 'timers/promises'

import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { loggers } from '@ydbjs/debug'
import { CommitError, YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'

import type { RetryConfig } from './config.js'
import type { RetryContext } from './context.js'
import { exponential, fixed } from './strategy.js'

export * from './config.js'
export * from './context.js'
export * as strategies from './strategy.js'

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
		(budget =
			typeof config.budget === 'number'
				? config.budget
				: config.budget!(ctx, config))
	) {
		let ac = new AbortController()
		let signal = cfg.signal
			? AbortSignal.any([cfg.signal, ac.signal])
			: ac.signal

		let start = Date.now()

		try {
			signal.throwIfAborted()
			dbg.log('attempt %d: calling retry function', ctx.attempt + 1)
			// oxlint-disable no-await-in-loop
			let result = await abortable(signal, Promise.resolve(fn(signal)))
			dbg.log('attempt %d: success', ctx.attempt + 1)
			return result
		} catch (error) {
			ctx.attempt += 1
			ctx.error = error

			if (error instanceof Error && error.name === 'AbortError') {
				dbg.log('attempt %d: abort error, not retryable', ctx.attempt)
				throw error
			}

			if (error instanceof Error && error.name === 'TimeoutError') {
				dbg.log('attempt %d: timeout error, not retryable', ctx.attempt)
				throw error
			}

			let retry: boolean
			if (typeof config.retry === 'boolean') {
				retry = config.retry
			} else {
				retry =
					config.retry?.(ctx.error, cfg.idempotent ?? false) ?? false
			}

			if (!retry || ctx.attempt >= budget) {
				dbg.log(
					'attempt %d: not retrying, error: %O',
					ctx.attempt,
					error
				)
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

			dbg.log(
				'attempt %d: waiting %d ms before next retry',
				ctx.attempt,
				remaining
			)
			// oxlint-disable no-await-in-loop
			await setTimeout(remaining, void 0, { signal: cfg.signal })

			if (config.onRetry) {
				config.onRetry(ctx)
			}
		} finally {
			ac.abort('Retry cancelled')
		}
	}

	dbg.log(
		'retry failed after %d attempts, last error: %O',
		ctx.attempt,
		ctx.error
	)
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
		return (
			error.retryable === true ||
			(error.retryable === 'conditionally' && idempotent)
		)
	}

	if (error instanceof CommitError) {
		return error.retryable(idempotent)
	}

	return false
}

export const defaultRetryConfig: RetryConfig = {
	retry: isRetryableError,
	budget: Infinity,
	strategy: (ctx, cfg) => {
		if (
			ctx.error instanceof YDBError &&
			ctx.error.code === StatusIds_StatusCode.BAD_SESSION
		) {
			return fixed(0)(ctx, cfg)
		}

		if (
			ctx.error instanceof YDBError &&
			ctx.error.code === StatusIds_StatusCode.SESSION_EXPIRED
		) {
			return fixed(0)(ctx, cfg)
		}

		if (
			ctx.error instanceof ClientError &&
			ctx.error.code === Status.ABORTED
		) {
			return fixed(0)(ctx, cfg)
		}

		if (
			ctx.error instanceof YDBError &&
			ctx.error.code === StatusIds_StatusCode.OVERLOADED
		) {
			return exponential(1000)(ctx, cfg)
		}

		if (
			ctx.error instanceof ClientError &&
			ctx.error.code === Status.RESOURCE_EXHAUSTED
		) {
			return exponential(1000)(ctx, cfg)
		}

		return exponential(10)(ctx, cfg)
	},
}
