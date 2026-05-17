import { channel, tracingChannel } from 'node:diagnostics_channel'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

import { metrics } from '@opentelemetry/api'
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'

import { installMetrics } from '../src/index.ts'
import { setupQueryMetrics } from '../src/metrics/query.ts'
import { setupRetryMetrics } from '../src/metrics/retry.ts'
import { setupSessionMetrics } from '../src/metrics/session.ts'

let exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
let reader = new PeriodicExportingMetricReader({
	exporter,
	exportIntervalMillis: 100_000,
	exportTimeoutMillis: 5_000,
})
let meterProvider = new MeterProvider({ readers: [reader] })
metrics.setGlobalMeterProvider(meterProvider)

let sessionAcquireCh = tracingChannel<{ kind: 'query' | 'transaction'; error?: unknown }>(
	'tracing:ydb:session.acquire'
)
let sessionCreateCh = tracingChannel<{
	liveSessions: number
	maxSize: number
	minSize: number
	creating: number
	error?: unknown
}>('tracing:ydb:session.create')
let sessionClosedCh = channel('ydb:session.closed')

let executeCh = tracingChannel<{
	text: string
	sessionId: string
	nodeId: bigint
	idempotent: boolean
	isolation: string
	stage: string
	error?: unknown
}>('tracing:ydb:query.execute')
let commitCh = tracingChannel<{ sessionId: string; transactionId: string; error?: unknown }>(
	'tracing:ydb:query.commit'
)
let rollbackCh = tracingChannel<{ sessionId: string; transactionId: string; error?: unknown }>(
	'tracing:ydb:query.rollback'
)

let retryRunCh = tracingChannel<{ idempotent: boolean; error?: unknown }>('tracing:ydb:retry.run')
let retryAttemptCh = tracingChannel<{
	attempt: number
	idempotent: boolean
	backoffMs: number
	error?: unknown
}>('tracing:ydb:retry.attempt')
let retryExhaustedCh = channel('ydb:retry.exhausted')

let unsubSession: () => void
let unsubQuery: () => void
let unsubRetry: () => void

beforeAll(() => {
	unsubSession = setupSessionMetrics({ 'ydb.query.session.pool.name': 'test-pool' })
	unsubQuery = setupQueryMetrics({ endpoint: 'grpc://127.0.0.1:2136', database: '/local' })
	unsubRetry = setupRetryMetrics({ database: '/local' })
})

afterAll(() => {
	unsubSession()
	unsubQuery()
	unsubRetry()
})

beforeEach(async () => {
	// Drain any residual delta before the next test.
	await reader.forceFlush()
	exporter.reset()
})

function findMetric(name: string) {
	for (let rm of exporter.getMetrics()) {
		for (let sm of rm.scopeMetrics) {
			let m = sm.metrics.find((x) => x.descriptor.name === name)
			if (m) return m
		}
	}
	return undefined
}

function histDp(metricName: string, opName: string): { count: number; sum: number } | undefined {
	let m = findMetric(metricName)
	let dp = m?.dataPoints.find(
		(d) => (d.attributes as Record<string, string>)['operation.name'] === opName
	)
	return dp ? (dp.value as { count: number; sum: number }) : undefined
}

async function readGauge(
	name: string,
	attrFilter: Record<string, string | boolean>
): Promise<number> {
	await reader.forceFlush()
	let m = findMetric(name)
	let dp = m?.dataPoints.find((d) => {
		for (let [k, v] of Object.entries(attrFilter)) {
			if ((d.attributes as Record<string, unknown>)[k] !== v) return false
		}
		return true
	}) as { value: number } | undefined
	return dp?.value ?? 0
}

test('session metrics — pending_requests counter increments on each acquire start', async () => {
	await sessionAcquireCh.tracePromise(async () => {}, { kind: 'query' })

	await reader.forceFlush()
	let m = findMetric('ydb.query.session.pending_requests')
	expect(m).toBeDefined()
	let total = m!.dataPoints.reduce((s, dp) => s + ((dp as { value: number }).value ?? 0), 0)
	expect(total).toBe(1)
})

test('session metrics — pending_requests increments once per acquire regardless of outcome', async () => {
	await sessionAcquireCh.tracePromise(async () => {}, { kind: 'query' })
	await sessionAcquireCh.tracePromise(async () => {}, { kind: 'transaction' })

	await reader.forceFlush()
	let m = findMetric('ydb.query.session.pending_requests')
	let total = m!.dataPoints.reduce((s, dp) => s + ((dp as { value: number }).value ?? 0), 0)
	expect(total).toBe(2)
})

test('session metrics — session.timeouts counter increments on TimeoutError during acquire', async () => {
	let timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
	await expect(
		sessionAcquireCh.tracePromise(
			async () => {
				throw timeoutErr
			},
			{ kind: 'query' }
		)
	).rejects.toThrow('timed out')

	await reader.forceFlush()
	let m = findMetric('ydb.query.session.timeouts')
	expect(m).toBeDefined()
	let total = m!.dataPoints.reduce((s, dp) => s + ((dp as { value: number }).value ?? 0), 0)
	expect(total).toBe(1)
})

test('session metrics — non-timeout errors do not increment session.timeouts', async () => {
	await expect(
		sessionAcquireCh.tracePromise(
			async () => {
				throw new Error('generic error')
			},
			{ kind: 'query' }
		)
	).rejects.toThrow('generic error')

	await reader.forceFlush()
	let m = findMetric('ydb.query.session.timeouts')
	let total = m?.dataPoints.reduce((s, dp) => s + ((dp as { value: number }).value ?? 0), 0) ?? 0
	expect(total).toBe(0)
})

test('session metrics — create_time histogram records on successful session creation', async () => {
	await sessionCreateCh.tracePromise(async () => {}, {
		liveSessions: 0,
		maxSize: 10,
		minSize: 1,
		creating: 0,
	})

	await reader.forceFlush()
	let m = findMetric('ydb.query.session.create_time')
	expect(m).toBeDefined()
	expect(m!.dataPoints.length).toBeGreaterThan(0)
	let dp = m!.dataPoints[0]!.value as { count: number; sum: number }
	expect(dp.count).toBe(1)
	expect(dp.sum).toBeGreaterThanOrEqual(0)
})

test('session metrics — create_time histogram records even when session creation fails', async () => {
	await expect(
		sessionCreateCh.tracePromise(
			async () => {
				throw new Error('create failed')
			},
			{ liveSessions: 0, maxSize: 10, minSize: 1, creating: 1 }
		)
	).rejects.toThrow('create failed')

	await reader.forceFlush()
	let m = findMetric('ydb.query.session.create_time')
	expect(m).toBeDefined()
	// The histogram accumulates across tests that share the same pool label;
	// assert >= 1 to verify the error path records a duration without
	// depending on exact isolation between test runs.
	let dp = m!.dataPoints[0]!.value as { count: number }
	expect(dp.count).toBeGreaterThanOrEqual(1)
})

test('session metrics — session.count active gauge increments by 1 after a successful create', async () => {
	let before = await readGauge('ydb.query.session.count', {
		'ydb.query.session.state': 'active',
	})
	exporter.reset()

	await sessionCreateCh.tracePromise(async () => {}, {
		liveSessions: 0,
		maxSize: 10,
		minSize: 1,
		creating: 0,
	})

	let after = await readGauge('ydb.query.session.count', {
		'ydb.query.session.state': 'active',
	})
	expect(after).toBe(before + 1)
})

test('session metrics — session.count active gauge decrements after ydb:session.closed', async () => {
	let before = await readGauge('ydb.query.session.count', {
		'ydb.query.session.state': 'active',
	})
	exporter.reset()

	await sessionCreateCh.tracePromise(async () => {}, {
		liveSessions: 0,
		maxSize: 10,
		minSize: 1,
		creating: 0,
	})
	sessionClosedCh.publish({ sessionId: 'sess-closed', nodeId: 1n })

	let after = await readGauge('ydb.query.session.count', {
		'ydb.query.session.state': 'active',
	})
	// Net change: create +1, close -1 → back to baseline
	expect(after).toBe(before)
})

test('session metrics — session.max and session.min gauges are reported after first create', async () => {
	await reader.forceFlush()
	let mMax = findMetric('ydb.query.session.max')
	let mMin = findMetric('ydb.query.session.min')
	expect(mMax).toBeDefined()
	expect(mMin).toBeDefined()
	let maxVal = (mMax!.dataPoints[0] as { value: number }).value
	let minVal = (mMin!.dataPoints[0] as { value: number }).value
	expect(maxVal).toBeGreaterThan(0)
	expect(minVal).toBeGreaterThan(0)
})

test('query metrics — operation.duration histogram records on successful ExecuteQuery', async () => {
	await executeCh.tracePromise(async () => {}, {
		text: 'SELECT 1',
		sessionId: 'sess-q1',
		nodeId: 1n,
		idempotent: true,
		isolation: 'serializableReadWrite',
		stage: 'standalone',
	})

	await reader.forceFlush()
	let dp = histDp('ydb.client.operation.duration', 'ExecuteQuery')
	expect(dp).toBeDefined()
	expect(dp!.count).toBe(1)
	expect(dp!.sum).toBeGreaterThanOrEqual(0)
})

test('query metrics — operation.duration histogram records on successful Commit', async () => {
	await commitCh.tracePromise(async () => {}, {
		sessionId: 'sess-commit',
		transactionId: 'tx-1',
	})

	await reader.forceFlush()
	let dp = histDp('ydb.client.operation.duration', 'Commit')
	expect(dp).toBeDefined()
	expect(dp!.count).toBe(1)
})

test('query metrics — operation.duration histogram records on successful Rollback', async () => {
	await rollbackCh.tracePromise(async () => {}, {
		sessionId: 'sess-rb',
		transactionId: 'tx-rb',
	})

	await reader.forceFlush()
	let dp = histDp('ydb.client.operation.duration', 'Rollback')
	expect(dp).toBeDefined()
	expect(dp!.count).toBe(1)
})

test('query metrics — operation.duration histogram records on successful CreateSession', async () => {
	await sessionCreateCh.tracePromise(async () => {}, {
		liveSessions: 0,
		maxSize: 10,
		minSize: 1,
		creating: 0,
	})

	await reader.forceFlush()
	let dp = histDp('ydb.client.operation.duration', 'CreateSession')
	expect(dp).toBeDefined()
	expect(dp!.count).toBe(1)
})

test('query metrics — operation.failed counter increments when ExecuteQuery errors', async () => {
	await expect(
		executeCh.tracePromise(
			async () => {
				throw new Error('query boom')
			},
			{
				text: 'SELECT bad',
				sessionId: 'sess-err',
				nodeId: 2n,
				idempotent: false,
				isolation: 'serializableReadWrite',
				stage: 'standalone',
			}
		)
	).rejects.toThrow('query boom')

	await reader.forceFlush()
	let m = findMetric('ydb.client.operation.failed')
	expect(m).toBeDefined()
	let dp = m!.dataPoints.find(
		(d) => (d.attributes as Record<string, string>)['operation.name'] === 'ExecuteQuery'
	)
	expect(dp).toBeDefined()
	expect(dp!.value as number).toBe(1)
})

test('query metrics — operation.duration is also recorded on failure', async () => {
	await expect(
		executeCh.tracePromise(
			async () => {
				throw new Error('slow query boom')
			},
			{
				text: 'SELECT slow',
				sessionId: 'sess-slow',
				nodeId: 3n,
				idempotent: false,
				isolation: 'serializableReadWrite',
				stage: 'standalone',
			}
		)
	).rejects.toThrow('slow query boom')

	await reader.forceFlush()
	let dp = histDp('ydb.client.operation.duration', 'ExecuteQuery')
	expect(dp).toBeDefined()
	expect(dp!.count).toBeGreaterThanOrEqual(1)
})

test('query metrics — multiple different operations produce separate data points', async () => {
	await executeCh.tracePromise(async () => {}, {
		text: 'SELECT 1',
		sessionId: 'sess-multi',
		nodeId: 1n,
		idempotent: true,
		isolation: 'serializableReadWrite',
		stage: 'standalone',
	})
	await commitCh.tracePromise(async () => {}, {
		sessionId: 'sess-multi',
		transactionId: 'tx-multi',
	})

	await reader.forceFlush()
	let m = findMetric('ydb.client.operation.duration')
	expect(m).toBeDefined()
	let opNames = m!.dataPoints.map(
		(dp) => (dp.attributes as Record<string, string>)['operation.name']
	)
	expect(opNames).toContain('ExecuteQuery')
	expect(opNames).toContain('Commit')
})

test('query metrics — operation.failed counter increments when Commit errors', async () => {
	await expect(
		commitCh.tracePromise(
			async () => {
				throw new Error('commit fail')
			},
			{ sessionId: 'sess-cf', transactionId: 'tx-cf' }
		)
	).rejects.toThrow('commit fail')

	await reader.forceFlush()
	let m = findMetric('ydb.client.operation.failed')
	let dp = m?.dataPoints.find(
		(d) => (d.attributes as Record<string, string>)['operation.name'] === 'Commit'
	)
	expect(dp).toBeDefined()
	expect(dp!.value as number).toBe(1)
})

test('retry metrics — retry.duration histogram records the total wall time of a retry run', async () => {
	await retryRunCh.tracePromise(async () => {}, { idempotent: true })

	await reader.forceFlush()
	let m = findMetric('ydb.client.retry.duration')
	expect(m).toBeDefined()
	expect(m!.dataPoints.length).toBeGreaterThan(0)
	let dp = m!.dataPoints[0]!.value as { count: number; sum: number }
	expect(dp.count).toBe(1)
	expect(dp.sum).toBeGreaterThanOrEqual(0)
})

test('retry metrics — retry.duration records duration even when retry run fails', async () => {
	await expect(
		retryRunCh.tracePromise(
			async () => {
				throw new Error('exhausted')
			},
			{ idempotent: false }
		)
	).rejects.toThrow('exhausted')

	await reader.forceFlush()
	let m = findMetric('ydb.client.retry.duration')
	expect(m).toBeDefined()
	// Filter to the specific data point for idempotent=false (error path uses false,
	// previous success test used true → different attribute bucket).
	let dp = m!.dataPoints.find(
		(d) => (d.attributes as Record<string, boolean>)['ydb.idempotent'] === false
	)
	expect(dp).toBeDefined()
	expect((dp!.value as { count: number }).count).toBeGreaterThanOrEqual(1)
})

test('retry metrics — idempotent=true and idempotent=false produce separate data points', async () => {
	await retryRunCh.tracePromise(async () => {}, { idempotent: true })
	await retryRunCh.tracePromise(async () => {}, { idempotent: false })

	await reader.forceFlush()
	let m = findMetric('ydb.client.retry.duration')
	expect(m).toBeDefined()
	expect(m!.dataPoints.length).toBe(2)
	let totalCount = m!.dataPoints.reduce(
		(s, dp) => s + ((dp.value as { count: number }).count ?? 0),
		0
	)
	expect(totalCount).toBe(2)
})

test('retry metrics — retry.attempts histogram records the attempt number on asyncEnd', async () => {
	await retryAttemptCh.tracePromise(async () => {}, {
		attempt: 1,
		idempotent: true,
		backoffMs: 0,
	})

	await reader.forceFlush()
	let m = findMetric('ydb.client.retry.attempts')
	expect(m).toBeDefined()
	let dp = m!.dataPoints[0]!.value as { count: number; sum: number }
	expect(dp.count).toBe(1)
	expect(dp.sum).toBe(1)
})

test('retry metrics — retry.attempts histogram records higher attempt numbers', async () => {
	await retryAttemptCh.tracePromise(async () => {}, {
		attempt: 3,
		idempotent: false,
		backoffMs: 200,
	})

	await reader.forceFlush()
	let m = findMetric('ydb.client.retry.attempts')
	expect(m).toBeDefined()
	let dp = m!.dataPoints[0]!.value as { count: number; sum: number }
	expect(dp.count).toBe(1)
	expect(dp.sum).toBe(3)
})

test('retry metrics — ydb:retry.exhausted plain channel records to retry.attempts', async () => {
	retryExhaustedCh.publish({
		attempts: 5,
		totalDuration: 2000,
		lastError: new Error('final failure'),
	})

	await reader.forceFlush()
	let m = findMetric('ydb.client.retry.attempts')
	expect(m).toBeDefined()
	let dp = m!.dataPoints[0]!.value as { count: number; sum: number }
	expect(dp.count).toBe(1)
	expect(dp.sum).toBe(5)
})

test('retry metrics — two sequential retry runs accumulate in the same data point', async () => {
	await retryRunCh.tracePromise(async () => {}, { idempotent: true })
	await retryRunCh.tracePromise(async () => {}, { idempotent: true })

	await reader.forceFlush()
	let m = findMetric('ydb.client.retry.duration')
	expect(m).toBeDefined()
	let dp = m!.dataPoints.find(
		(d) => (d.attributes as Record<string, boolean>)['ydb.idempotent'] === true
	)
	expect(dp).toBeDefined()
	expect((dp!.value as { count: number }).count).toBe(2)
})

test('installMetrics returns disposers for each module and they unsub cleanly', () => {
	let disposers = installMetrics({ endpoint: 'grpc://127.0.0.1:2136/local' })
	expect(disposers.length).toBeGreaterThan(0)
	for (let d of disposers) {
		expect(typeof d).toBe('function')
		expect(() => d()).not.toThrow()
	}
})

test('installMetrics with no options returns disposers', () => {
	let disposers = installMetrics()
	expect(disposers.length).toBeGreaterThan(0)
	for (let d of disposers) d()
})
