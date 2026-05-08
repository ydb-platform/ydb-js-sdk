import { metrics } from '@opentelemetry/api'

import { safeSubscribe, safeTracingSubscribe } from '../safe.js'
import pkg from '../../package.json' with { type: 'json' }

type RetryRunCtx = {
	idempotent: boolean
	error?: unknown
	_metricsStart?: number
}

type RetryAttemptCtx = {
	attempt: number
	idempotent: boolean
	backoffMs: number
	error?: unknown
}

type RetryExhaustedMsg = {
	attempts: number
	totalDuration: number
	lastError: unknown
}

/**
 * - ydb.client.retry.duration: total wall-clock cost of one retry() call in seconds
 *   (includes all attempts + backoff delays). One observation per retry() invocation.
 *
 * - ydb.client.retry.attempts: total attempts the retry() call required.
 *   One observation per retry() invocation; value 1 means first-try success.
 */
export function setupRetryMetrics(
	base: Record<string, string | number | boolean> = {}
): () => void {
	let meter = metrics.getMeter(pkg.name, pkg.version)

	let retryDuration = meter.createHistogram('ydb.client.retry.duration', {
		description:
			'Total duration of a retry() call in seconds, including all attempts and backoff delays',
		unit: 's',
		advice: {
			explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
		},
	})

	let retryAttempts = meter.createHistogram('ydb.client.retry.attempts', {
		description: 'Total number of attempts per retry() invocation (1 = first-try success)',
		unit: '{attempt}',
		advice: {
			explicitBucketBoundaries: [1, 2, 3, 5, 10],
		},
	})

	let unsubRetryRun = safeTracingSubscribe<RetryRunCtx>('tracing:ydb:retry.run', {
		start(ctx) {
			ctx._metricsStart = performance.now()
		},
		asyncEnd(ctx) {
			if (ctx._metricsStart !== undefined) {
				retryDuration.record((performance.now() - ctx._metricsStart) / 1000, {
					...base,
					'ydb.idempotent': ctx.idempotent,
				})
			}
		},
		error(ctx) {
			if (ctx._metricsStart !== undefined) {
				retryDuration.record((performance.now() - ctx._metricsStart) / 1000, {
					...base,
					'ydb.idempotent': ctx.idempotent,
				})
			}
		},
	})

	let unsubRetryAttempt = safeTracingSubscribe<RetryAttemptCtx>('tracing:ydb:retry.attempt', {
		asyncEnd(ctx) {
			retryAttempts.record(ctx.attempt, {
				...base,
				'ydb.idempotent': ctx.idempotent,
			})
		},
	})

	let unsubExhausted = safeSubscribe('ydb:retry.exhausted', (msg) => {
		let m = msg as RetryExhaustedMsg
		retryAttempts.record(m.attempts, base)
	})

	return () => {
		unsubRetryRun()
		unsubRetryAttempt()
		unsubExhausted()
	}
}
