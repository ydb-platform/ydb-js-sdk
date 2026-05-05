import { safeTracingSubscribe } from '../safe.js'
import { SpanKind } from '../tracing.js'
import type { TracingSetup } from '../context-manager.js'

type RetryRunCtx = { idempotent: boolean; error?: unknown }
type RetryAttemptCtx = { attempt: number; idempotent: boolean; error?: unknown }

export function subscribeRetryTracing(setup: TracingSetup): () => void {
	let { enter, finishOk, finishError, noop, base } = setup

	let unsubRetryRun = safeTracingSubscribe<RetryRunCtx>('tracing:ydb:retry.run', {
		start(ctx) {
			enter(ctx, 'ydb.RunWithRetry', {
				kind: SpanKind.INTERNAL,
				attributes: {
					...base,
					'db.operation.name': 'RunWithRetry',
					'ydb.idempotent': ctx.idempotent,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	let unsubRetryAttempt = safeTracingSubscribe<RetryAttemptCtx>('tracing:ydb:retry.attempt', {
		start(ctx) {
			enter(ctx, 'ydb.Try', {
				kind: SpanKind.INTERNAL,
				attributes: {
					...base,
					'db.operation.name': 'Try',
					'ydb.retry.attempt': ctx.attempt,
					'ydb.idempotent': ctx.idempotent,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	return () => {
		unsubRetryRun()
		unsubRetryAttempt()
	}
}
