import { safeTracingSubscribe } from '../safe.js'
import { SpanKind } from '../tracing.js'
import type { TracingSetup } from '../context-manager.js'

type DriverInitCtx = {
	database: string
	endpoint: string
	discovery: boolean
	error?: unknown
}

export function subscribeDriverTracing(setup: TracingSetup): () => void {
	let { enter, finishOk, finishError, noop, base } = setup

	let unsubDriverInit = safeTracingSubscribe<DriverInitCtx>('tracing:ydb:driver.init', {
		start(ctx) {
			enter(ctx, 'ydb.DriverInit', {
				kind: SpanKind.INTERNAL,
				attributes: {
					...base,
					'db.operation.name': 'DriverInit',
					'db.namespace': ctx.database,
					'server.address': ctx.endpoint,
					'ydb.discovery.enabled': ctx.discovery,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	return () => {
		unsubDriverInit()
	}
}
