import { metrics } from '@opentelemetry/api'

import { recordErrorAttributes } from '../attributes.js'
import { safeTracingSubscribe } from '../safe.js'
import pkg from '../../package.json' with { type: 'json' }

type OpCtx = {
	error?: unknown
	_metricsStart?: number
}

// Sets up metrics for YDB query operations

function queryOperationLabels(
	base: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
	let out: Record<string, string | number | boolean> = {}
	if (base['database'] !== undefined) out['database'] = base['database']
	if (base['endpoint'] !== undefined) out['endpoint'] = base['endpoint']
	return out
}

export function setupQueryMetrics(
	base: Record<string, string | number | boolean> = {}
): () => void {
	let meter = metrics.getMeter(pkg.name, pkg.version)

	let operationLabels = queryOperationLabels(base)

	let operationDuration = meter.createHistogram('ydb.client.operation.duration', {
		description: 'Duration of YDB client operations in seconds',
		unit: 's',
		advice: {
			explicitBucketBoundaries: [
				0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5,
				3, 5, 10,
			],
		},
	})

	let operationFailed = meter.createCounter('ydb.client.operation.failed', {
		description: 'Number of failed YDB client operations',
		unit: '{operation}',
	})

	function trackOp(channelName: string, operationName: string): () => void {
		return safeTracingSubscribe<OpCtx>(channelName, {
			start(ctx) {
				ctx._metricsStart = performance.now()
			},
			asyncEnd(ctx) {
				if (ctx._metricsStart !== undefined) {
					operationDuration.record((performance.now() - ctx._metricsStart) / 1000, {
						...operationLabels,
						'operation.name': operationName,
					})
				}
			},
			error(ctx) {
				let errAttrs = recordErrorAttributes(ctx.error)
				if (ctx._metricsStart !== undefined) {
					operationDuration.record((performance.now() - ctx._metricsStart) / 1000, {
						...operationLabels,
						'operation.name': operationName,
					})
				}
				operationFailed.add(1, {
					...operationLabels,
					'operation.name': operationName,
					status_code: errAttrs['db.response.status_code'],
				})
			},
		})
	}

	let unsubExecute = trackOp('tracing:ydb:query.execute', 'ExecuteQuery')
	let unsubCommit = trackOp('tracing:ydb:query.commit', 'Commit')
	let unsubRollback = trackOp('tracing:ydb:query.rollback', 'Rollback')
	let unsubCreate = trackOp('tracing:ydb:session.create', 'CreateSession')

	return () => {
		unsubExecute()
		unsubCommit()
		unsubRollback()
		unsubCreate()
	}
}
