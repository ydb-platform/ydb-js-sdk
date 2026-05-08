import { safeSubscribe, safeTracingSubscribe } from '../safe.js'
import { SpanKind } from '../tracing.js'
import type { TracingSetup } from '../context-manager.js'
import { getActiveSubscriberSpan } from '../context-manager.js'

type DiscoveryCtx = { database: string; periodic: boolean; error?: unknown }

type DiscoveryCompletedMsg = {
	database: string
	addedCount: number
	removedCount: number
	totalCount: number
	duration: number
}

export function subscribeDiscoveryTracing(setup: TracingSetup): () => void {
	let { enter, finishOk, finishError, noop, base } = setup

	let unsubDiscovery = safeTracingSubscribe<DiscoveryCtx>('tracing:ydb:discovery', {
		start(ctx) {
			enter(ctx, 'ydb.Discovery', {
				kind: SpanKind.CLIENT,
				attributes: {
					...base,
					'db.operation.name': 'Discovery',
					'db.namespace': ctx.database,
					'ydb.discovery.periodic': ctx.periodic,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	let unsubCompleted = safeSubscribe('ydb:discovery.completed', (msg) => {
		let m = msg as DiscoveryCompletedMsg
		let span = getActiveSubscriberSpan()
		if (span) {
			span.setAttributes({
				'ydb.discovery.added_count': m.addedCount,
				'ydb.discovery.removed_count': m.removedCount,
				'ydb.discovery.total_count': m.totalCount,
				'ydb.discovery.duration_ms': m.duration,
			})
		}
	})

	return () => {
		unsubDiscovery()
		unsubCompleted()
	}
}
