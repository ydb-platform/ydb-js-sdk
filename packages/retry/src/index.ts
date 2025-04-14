import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'

import type { RetryConfig } from './config.js'
import type { RetryContext } from './context.js'
import { exponential, fixed } from './strategy.js'

export * from './config.js'
export * from './context.js'

export async function retry<R>(cfg: RetryConfig, fn: (signal: AbortSignal) => R | Promise<R>): Promise<R> {
	let config = Object.assign({}, defaultRetryConfig, cfg)
	let ctx: RetryContext = { attempt: 0, error: null }

	let budget: number
	while (ctx.attempt < (budget = typeof config.budget === 'number' ? config.budget : config.budget!(ctx, config))) {
		let start = Date.now()
		let controller = new AbortController()

		try {
			cfg.signal?.throwIfAborted()
			// oxlint-disable no-await-in-loop
			return await fn(controller.signal)
		} catch (error) {
			ctx.attempt += 1
			ctx.error = error

			let retry = typeof config.retry === 'function' ? config.retry(ctx.error, cfg.idempotent ?? false) : config.retry
			if (!retry || ctx.attempt >= budget) {
				throw error
			}

			let delay = typeof config.strategy === 'number' ? config.strategy : config.strategy!(ctx, config)
			let remaining = Math.max(delay - (Date.now() - start), 0)
			if (!remaining) {
				continue
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
		} finally {
			controller.abort('Retry cancelled')
		}
	}

	throw new Error('Retry budget exceeded')
}

export const defaultRetryConfig: RetryConfig = {
	retry: (err, idempotent) => {
		return (
			(err instanceof ClientError && err.code === Status.ABORTED) ||
			(err instanceof ClientError && err.code === Status.INTERNAL) ||
			(err instanceof ClientError && err.code === Status.RESOURCE_EXHAUSTED) ||

			(err instanceof ClientError && err.code === Status.UNAVAILABLE && idempotent) ||

			(err instanceof YDBError && err.code === StatusIds_StatusCode.ABORTED) ||
			(err instanceof YDBError && err.code === StatusIds_StatusCode.OVERLOADED) ||
			(err instanceof YDBError && err.code === StatusIds_StatusCode.UNAVAILABLE) ||
			(err instanceof YDBError && err.code === StatusIds_StatusCode.BAD_SESSION) ||
			(err instanceof YDBError && err.code === StatusIds_StatusCode.SESSION_BUSY) ||

			(err instanceof YDBError && err.code === StatusIds_StatusCode.SESSION_EXPIRED && idempotent) ||
			(err instanceof YDBError && err.code === StatusIds_StatusCode.UNDETERMINED && idempotent) ||
			(err instanceof YDBError && err.code === StatusIds_StatusCode.TIMEOUT && idempotent)
		)
	},
	budget: Infinity,
	strategy: (ctx, cfg) => {
		if (ctx.error instanceof YDBError && ctx.error.code === StatusIds_StatusCode.BAD_SESSION) {
			return fixed(0)(ctx, cfg)
		}

		if (ctx.error instanceof YDBError && ctx.error.code === StatusIds_StatusCode.SESSION_EXPIRED) {
			return fixed(0)(ctx, cfg)
		}

		if (ctx.error instanceof ClientError && ctx.error.code === Status.ABORTED) {
			return fixed(0)(ctx, cfg)
		}

		if (ctx.error instanceof YDBError && ctx.error.code === StatusIds_StatusCode.OVERLOADED) {
			return exponential(1000)(ctx, cfg)
		}

		if (ctx.error instanceof ClientError && ctx.error.code === Status.RESOURCE_EXHAUSTED) {
			return exponential(1000)(ctx, cfg)
		}

		return exponential(10)(ctx, cfg)
	},
}
