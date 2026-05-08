import { safeTracingSubscribe } from '../safe.js'
import { SpanKind } from '../tracing.js'
import type { TracingSetup } from '../context-manager.js'

type AuthTokenFetchCtx = {
	provider: 'static' | 'metadata' | 'iam' | 'access_token' | 'anonymous'
	error?: unknown
}

export function subscribeAuthTracing(setup: TracingSetup): () => void {
	let { enter, finishOk, finishError, noop, base } = setup

	let unsubTokenFetch = safeTracingSubscribe<AuthTokenFetchCtx>('tracing:ydb:auth.token.fetch', {
		start(ctx) {
			enter(ctx, 'ydb.TokenFetch', {
				kind: SpanKind.INTERNAL,
				attributes: {
					...base,
					'db.operation.name': 'TokenFetch',
					'ydb.auth.provider': ctx.provider,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	return () => {
		unsubTokenFetch()
	}
}
