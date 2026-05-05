import { safeTracingSubscribe } from '../safe.js'
import { SpanKind } from '../tracing.js'
import type { TracingSetup } from '../context-manager.js'

type SessionAcquireCtx = { kind: 'query' | 'transaction'; error?: unknown }

type SessionCreateCtx = {
	liveSessions: number
	maxSize: number
	creating: number
	error?: unknown
}

export function subscribeSessionTracing(setup: TracingSetup): () => void {
	let { enter, finishOk, finishError, noop, base } = setup

	let unsubAcquire = safeTracingSubscribe<SessionAcquireCtx>('tracing:ydb:session.acquire', {
		start(ctx) {
			enter(ctx, 'ydb.AcquireSession', {
				kind: SpanKind.INTERNAL,
				attributes: {
					...base,
					'db.operation.name': 'AcquireSession',
					'ydb.session.kind': ctx.kind,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	let unsubCreate = safeTracingSubscribe<SessionCreateCtx>('tracing:ydb:session.create', {
		start(ctx) {
			enter(ctx, 'ydb.CreateSession', {
				kind: SpanKind.CLIENT,
				attributes: {
					...base,
					'db.operation.name': 'CreateSession',
					'ydb.pool.live_sessions': ctx.liveSessions,
					'ydb.pool.max_size': ctx.maxSize,
					'ydb.pool.creating': ctx.creating,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	return () => {
		unsubAcquire()
		unsubCreate()
	}
}
