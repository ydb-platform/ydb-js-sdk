import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'

import type { RetryConfig } from './config.js'
import type { RetryContext } from './context.js'
import { exponential, fixed } from './strategy.js'

export * from './config.js'
export * from './context.js'

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
			// oxlint-disable no-await-in-loop
			return await fn()
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

export const defaultRetryConfig: RetryConfig = {
	retry: (err) => {
		return (
			(err instanceof ClientError && err.code !== Status.CANCELLED) ||
			(err instanceof ClientError && err.code !== Status.UNKNOWN) ||
			(err instanceof ClientError && err.code !== Status.INVALID_ARGUMENT) ||
			(err instanceof ClientError && err.code !== Status.NOT_FOUND) ||
			(err instanceof ClientError && err.code !== Status.ALREADY_EXISTS) ||
			(err instanceof ClientError && err.code !== Status.PERMISSION_DENIED) ||
			(err instanceof ClientError && err.code !== Status.FAILED_PRECONDITION) ||
			(err instanceof ClientError && err.code !== Status.OUT_OF_RANGE) ||
			(err instanceof ClientError && err.code !== Status.UNIMPLEMENTED) ||
			(err instanceof ClientError && err.code !== Status.DATA_LOSS) ||
			(err instanceof ClientError && err.code !== Status.UNAUTHENTICATED) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.BAD_REQUEST) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.UNAUTHORIZED) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.INTERNAL_ERROR) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.SCHEME_ERROR) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.GENERIC_ERROR) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.TIMEOUT) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.PRECONDITION_FAILED) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.ALREADY_EXISTS) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.NOT_FOUND) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.CANCELLED) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.UNSUPPORTED) ||
			(err instanceof YDBError && err.code !== StatusIds_StatusCode.EXTERNAL_ERROR) ||
			(err instanceof Error && err.name !== 'TimeoutError') ||
			(err instanceof Error && err.name !== 'AbortError')
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
