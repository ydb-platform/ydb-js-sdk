import { metrics } from '@opentelemetry/api'

import { safeSubscribe, safeTracingSubscribe } from '../safe.js'
import pkg from '../../package.json' with { type: 'json' }

type SessionAcquireCtx = {
	kind: 'query' | 'transaction'
	error?: unknown
}

type SessionCreateCtx = {
	liveSessions: number
	maxSize: number
	minSize: number
	creating: number
	error?: unknown
	_metricsStart?: number
}

/**
 * Sets up metrics for the YDB query session pool:
 * - ydb.query.session.create_time:      histogram of session creation latency (s)
 * - ydb.query.session.pending_requests: counter of requests that started waiting for a session
 * - ydb.query.session.timeouts:         counter of session acquisition timeouts
 * - ydb.query.session.count:            observable gauge of session counts by state (active/creating)
 * - ydb.query.session.max:              observable gauge of configured MaxPoolSize
 * - ydb.query.session.min:              observable gauge of configured MinPoolSize
 *
 * Tag ydb.query.session.pool.name is taken from base['ydb.query.session.pool.name'] if provided.
 *
 * session.count tracking is event-driven (not snapshot-based) to stay correct under
 * concurrent session creation:
 *   session.create start     → creating++
 *   session.create asyncEnd  → creating--, active++
 *   session.create error     → creating--
 *   ydb:session.closed       → active--
 */
export function setupSessionMetrics(
	base: Record<string, string | number | boolean> = {}
): () => void {
	let meter = metrics.getMeter(pkg.name, pkg.version)

	let poolLabels: Record<string, string | number | boolean> = {
		'ydb.query.session.pool.name': base['ydb.query.session.pool.name'] ?? '',
	}

	let sessionCreateTime = meter.createHistogram('ydb.query.session.create_time', {
		description: 'Session creation cost in seconds',
		unit: 's',
		advice: {
			explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
		},
	})

	let pendingRequests = meter.createCounter('ydb.query.session.pending_requests', {
		description: 'Number of requests that started waiting for an available session',
		unit: '{request}',
	})

	let sessionTimeouts = meter.createCounter('ydb.query.session.timeouts', {
		description: 'Number of session acquisition requests that timed out',
		unit: '{timeout}',
	})

	let activeCount = 0
	let creatingCount = 0
	let maxPoolSize = 0
	let minPoolSize = 0

	let sessionCountGauge = meter.createObservableGauge('ydb.query.session.count', {
		description: 'Current number of sessions in the pool by state',
		unit: '{session}',
	})

	let sessionMaxGauge = meter.createObservableGauge('ydb.query.session.max', {
		description: 'Configured MaxPoolSize',
		unit: '{session}',
	})

	let sessionMinGauge = meter.createObservableGauge('ydb.query.session.min', {
		description: 'Configured MinPoolSize',
		unit: '{session}',
	})

	meter.addBatchObservableCallback(
		(result) => {
			result.observe(sessionCountGauge, activeCount, {
				...poolLabels,
				'ydb.query.session.state': 'active',
			})
			result.observe(sessionCountGauge, creatingCount, {
				...poolLabels,
				'ydb.query.session.state': 'creating',
			})
			result.observe(sessionMaxGauge, maxPoolSize, poolLabels)
			result.observe(sessionMinGauge, minPoolSize, poolLabels)
		},
		[sessionCountGauge, sessionMaxGauge, sessionMinGauge]
	)

	let unsubAcquire = safeTracingSubscribe<SessionAcquireCtx>('tracing:ydb:session.acquire', {
		start(_ctx) {
			pendingRequests.add(1, poolLabels)
		},
		asyncEnd(_ctx) {},
		error(ctx) {
			// AbortSignal.timeout() rejects with a DOMException { name: 'TimeoutError' }
			let err = ctx.error
			let isTimeout =
				(err instanceof Error && err.name === 'TimeoutError') ||
				(err instanceof Error &&
					err.name === 'AbortError' &&
					(err as DOMException).code === 23)
			if (isTimeout) {
				sessionTimeouts.add(1, poolLabels)
			}
		},
	})

	let unsubCreate = safeTracingSubscribe<SessionCreateCtx>('tracing:ydb:session.create', {
		start(ctx) {
			ctx._metricsStart = performance.now()
			creatingCount++
			// latch config values on first sight — they're constant for the pool's lifetime
			if (maxPoolSize === 0) maxPoolSize = ctx.maxSize
			if (minPoolSize === 0) minPoolSize = ctx.minSize
		},
		asyncEnd(ctx) {
			if (ctx._metricsStart !== undefined) {
				sessionCreateTime.record((performance.now() - ctx._metricsStart) / 1000, poolLabels)
			}
			creatingCount = Math.max(0, creatingCount - 1)
			activeCount++
		},
		error(ctx) {
			if (ctx._metricsStart !== undefined) {
				sessionCreateTime.record((performance.now() - ctx._metricsStart) / 1000, poolLabels)
			}
			creatingCount = Math.max(0, creatingCount - 1)
		},
	})

	// ydb:session.closed fires on eviction and pool shutdown
	let unsubClosed = safeSubscribe('ydb:session.closed', (_msg) => {
		activeCount = Math.max(0, activeCount - 1)
	})

	return () => {
		unsubAcquire()
		unsubCreate()
		unsubClosed()
	}
}
