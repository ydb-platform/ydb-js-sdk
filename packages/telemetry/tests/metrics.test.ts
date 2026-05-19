import { channel, tracingChannel } from 'node:diagnostics_channel'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { type MetricAttributes, metrics } from '@opentelemetry/api'
import {
	AggregationTemporality,
	type DataPoint,
	type Histogram as HistogramData,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

import { YdbInstrumentation } from '../src/index.ts'

let exporter: InMemoryMetricExporter
let reader: PeriodicExportingMetricReader
let provider: MeterProvider
let instrumentation: YdbInstrumentation

beforeEach(() => {
	exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
	reader = new PeriodicExportingMetricReader({
		exporter,
		// Long enough that it never auto-fires within a test; we drive flushes
		// explicitly via provider.forceFlush().
		exportIntervalMillis: 60_000,
		exportTimeoutMillis: 5_000,
	})
	provider = new MeterProvider({ readers: [reader] })
	metrics.setGlobalMeterProvider(provider)
	instrumentation = new YdbInstrumentation()
	instrumentation.enable()
})

afterEach(async () => {
	instrumentation.disable()
	await provider.shutdown()
	metrics.disable()
})

let driverIdentity = {
	address: '127.0.0.1',
	port: 2136,
	database: '/local',
	registeredAt: 0,
}

async function collect(): Promise<ResourceMetrics> {
	await provider.forceFlush()
	let exported = exporter.getMetrics()
	return exported[exported.length - 1]
}

function findInstrument(rm: ResourceMetrics, name: string) {
	for (let scope of rm.scopeMetrics) {
		let found = scope.metrics.find((inst) => inst.descriptor.name === name)
		if (found) return found
	}
	throw new Error(`no instrument named ${name}`)
}

function findPoint<T>(rm: ResourceMetrics, name: string, filter: MetricAttributes): DataPoint<T> {
	let inst = findInstrument(rm, name)
	let point = (inst.dataPoints as DataPoint<T>[]).find((p) =>
		Object.entries(filter).every(([k, v]) => (p.attributes as Record<string, unknown>)[k] === v)
	)
	if (!point) {
		throw new Error(
			`no datapoint for ${name} matching ${JSON.stringify(filter)}. Got: ${JSON.stringify(inst.dataPoints.map((p) => p.attributes))}`
		)
	}
	return point
}

// --- duration histogram ----------------------------------------------------

test('records db.client.operation.duration on tracing:ydb:query.execute', async () => {
	let exec = tracingChannel('tracing:ydb:query.execute')
	await exec.tracePromise(async () => {}, {
		driver: driverIdentity,
		text: 'SELECT 1',
		sessionId: 's1',
		nodeId: 1n,
		idempotent: false,
		isolation: 'serializableReadWrite',
	})

	let rm = await collect()
	let point = findPoint<HistogramData>(rm, 'db.client.operation.duration', {
		'db.operation.name': 'Query.ExecuteQuery',
		'db.namespace': '/local',
		'server.address': '127.0.0.1',
		'db.system.name': 'ydb',
	})
	expect(point.value.count).toBe(1)
	expect(point.value.sum).toBeGreaterThanOrEqual(0)
})

test('records db.client.operation.duration on tracing:ydb:query.session.delete', async () => {
	let del = tracingChannel('tracing:ydb:query.session.delete')
	await del.tracePromise(async () => {}, {
		driver: driverIdentity,
		sessionId: 's1',
		nodeId: 1n,
		reason: 'pool_close',
		uptime: 1000,
	})

	let rm = await collect()
	let point = findPoint<HistogramData>(rm, 'db.client.operation.duration', {
		'db.operation.name': 'Query.DeleteSession',
		'db.namespace': '/local',
		'server.address': '127.0.0.1',
		'db.system.name': 'ydb',
	})
	expect(point.value.count).toBe(1)
})

test('tags db.client.operation.duration with error.type when the channel fires error', async () => {
	let exec = tracingChannel('tracing:ydb:query.execute')
	await expect(
		exec.tracePromise(
			async () => {
				let e = new Error('boom')
				e.name = 'TimeoutError'
				throw e
			},
			{
				driver: driverIdentity,
				text: 'SELECT 1',
				sessionId: 's1',
				nodeId: 1n,
				idempotent: false,
				isolation: 'serializableReadWrite',
			}
		)
	).rejects.toThrow('boom')

	let rm = await collect()
	let point = findPoint<HistogramData>(rm, 'db.client.operation.duration', {
		'db.operation.name': 'Query.ExecuteQuery',
		'error.type': 'TimeoutError',
	})
	expect(point.value.count).toBe(1)
})

// --- counters --------------------------------------------------------------

test('counts ydb.driver.connection.pessimizations from pessimized event', async () => {
	channel('ydb:driver.connection.pessimized').publish({
		driver: driverIdentity,
		nodeId: 7n,
		address: '10.0.0.1:2135',
		location: 'dc1',
		until: Date.now() + 5000,
	})
	channel('ydb:driver.connection.pessimized').publish({
		driver: driverIdentity,
		nodeId: 8n,
		address: '10.0.0.2:2135',
		location: 'dc1',
		until: Date.now() + 5000,
	})

	let rm = await collect()
	let point = findPoint<number>(rm, 'ydb.driver.connection.pessimizations', {
		'db.namespace': '/local',
	})
	expect(point.value).toBe(2)
})

test('counts ydb.query.session.closed with close.reason tag', async () => {
	channel('ydb:query.session.closed').publish({
		driver: driverIdentity,
		sessionId: 's1',
		nodeId: 1n,
		reason: 'stream_error',
		uptime: 1000,
	})
	channel('ydb:query.session.closed').publish({
		driver: driverIdentity,
		sessionId: 's2',
		nodeId: 1n,
		reason: 'pool_close',
		uptime: 2000,
	})

	let rm = await collect()
	let streamError = findPoint<number>(rm, 'ydb.query.session.closed', {
		'ydb.session.close.reason': 'stream_error',
	})
	let poolClose = findPoint<number>(rm, 'ydb.query.session.closed', {
		'ydb.session.close.reason': 'pool_close',
	})
	expect(streamError.value).toBe(1)
	expect(poolClose.value).toBe(1)
})

test('counts ydb.retry.attempts with outcome tag from retry.attempt.completed', async () => {
	channel('ydb:retry.attempt.completed').publish({
		attempt: 1,
		idempotent: true,
		outcome: 'retried',
	})
	channel('ydb:retry.attempt.completed').publish({
		attempt: 2,
		idempotent: true,
		outcome: 'success',
	})

	let rm = await collect()
	let retried = findPoint<number>(rm, 'ydb.retry.attempts', { 'ydb.retry.outcome': 'retried' })
	let success = findPoint<number>(rm, 'ydb.retry.attempts', { 'ydb.retry.outcome': 'success' })
	expect(retried.value).toBe(1)
	expect(success.value).toBe(1)
})

test('counts ydb.auth.token.fetch.failures with provider tag', async () => {
	channel('ydb:auth.provider.failed').publish({
		provider: 'static',
		error: new Error('network down'),
	})

	let rm = await collect()
	let point = findPoint<number>(rm, 'ydb.auth.token.fetch.failures', {
		'ydb.auth.provider': 'static',
	})
	expect(point.value).toBe(1)
})

test('counts ydb.auth.token.expirations with provider tag', async () => {
	channel('ydb:auth.token.expired').publish({ provider: 'metadata' })

	let rm = await collect()
	let point = findPoint<number>(rm, 'ydb.auth.token.expirations', {
		'ydb.auth.provider': 'metadata',
	})
	expect(point.value).toBe(1)
})

test('counts ydb.auth.token.refreshes with provider tag', async () => {
	channel('ydb:auth.token.refreshed').publish({
		provider: 'yc-service-account',
		expiresAt: Date.now() + 3_600_000,
	})
	channel('ydb:auth.token.refreshed').publish({
		provider: 'yc-service-account',
		expiresAt: Date.now() + 3_600_000,
	})
	channel('ydb:auth.token.refreshed').publish({
		provider: 'static',
		expiresAt: Date.now() + 60_000,
	})

	let rm = await collect()
	let yc = findPoint<number>(rm, 'ydb.auth.token.refreshes', {
		'ydb.auth.provider': 'yc-service-account',
	})
	let stat = findPoint<number>(rm, 'ydb.auth.token.refreshes', {
		'ydb.auth.provider': 'static',
	})
	expect(yc.value).toBe(2)
	expect(stat.value).toBe(1)
})

// --- observable gauge ------------------------------------------------------

test('observes ydb.driver.connection.count split by ydb.connection.state', async () => {
	channel('ydb:driver.connection.added').publish({ driver: driverIdentity, nodeId: 1n })
	channel('ydb:driver.connection.added').publish({ driver: driverIdentity, nodeId: 2n })
	channel('ydb:driver.connection.added').publish({ driver: driverIdentity, nodeId: 3n })
	channel('ydb:driver.connection.pessimized').publish({
		driver: driverIdentity,
		nodeId: 2n,
		address: '10.0.0.2:2135',
		location: 'dc1',
		until: Date.now() + 5000,
	})

	let rm = await collect()
	let live = findPoint<number>(rm, 'ydb.driver.connection.count', {
		'ydb.connection.state': 'live',
		'db.namespace': '/local',
	})
	let pessimized = findPoint<number>(rm, 'ydb.driver.connection.count', {
		'ydb.connection.state': 'pessimized',
		'db.namespace': '/local',
	})
	expect(live.value).toBe(2)
	expect(pessimized.value).toBe(1)
})

test('observes ydb.query.session.count split by ydb.session.state', async () => {
	channel('ydb:query.session.pool.opened').publish({
		driver: driverIdentity,
		maxSize: 10,
		minSize: 0,
	})
	channel('ydb:query.session.created').publish({
		driver: driverIdentity,
		sessionId: 's1',
		nodeId: 1n,
	})
	channel('ydb:query.session.created').publish({
		driver: driverIdentity,
		sessionId: 's2',
		nodeId: 1n,
	})
	channel('ydb:query.session.created').publish({
		driver: driverIdentity,
		sessionId: 's3',
		nodeId: 1n,
	})
	channel('ydb:query.session.acquired').publish({
		driver: driverIdentity,
		sessionId: 's2',
		nodeId: 1n,
	})
	channel('ydb:query.session.closed').publish({
		driver: driverIdentity,
		sessionId: 's1',
		nodeId: 1n,
		reason: 'stream_closed',
		uptime: 100,
	})

	let rm = await collect()
	let idle = findPoint<number>(rm, 'ydb.query.session.count', {
		'ydb.session.state': 'idle',
		'db.namespace': '/local',
	})
	let acquired = findPoint<number>(rm, 'ydb.query.session.count', {
		'ydb.session.state': 'acquired',
		'db.namespace': '/local',
	})
	let creating = findPoint<number>(rm, 'ydb.query.session.count', {
		'ydb.session.state': 'creating',
		'db.namespace': '/local',
	})
	// total = 2 (3 created − 1 closed). acquired = 1 (s2). idle = total − acquired.
	expect(acquired.value).toBe(1)
	expect(idle.value).toBe(1)
	expect(creating.value).toBe(0)
})

test('records ydb.query.session.create.duration and reports creating state mid-flight', async () => {
	let createCh = tracingChannel('tracing:ydb:query.session.create')
	let started = Promise.withResolvers<void>()
	let finish = Promise.withResolvers<void>()

	let traced = createCh.tracePromise(
		async () => {
			started.resolve()
			await finish.promise
		},
		{ driver: driverIdentity }
	)

	await started.promise
	// `creating` is incremented by the start hook and decremented by asyncEnd —
	// observe it while the traced fn is suspended.
	let midflight = await collect()
	let creating = findPoint<number>(midflight, 'ydb.query.session.count', {
		'ydb.session.state': 'creating',
		'db.namespace': '/local',
	})
	expect(creating.value).toBe(1)

	finish.resolve()
	await traced

	let rm = await collect()
	let dur = findPoint<HistogramData>(rm, 'ydb.query.session.create.duration', {
		'db.namespace': '/local',
	})
	expect(dur.value.count).toBe(1)

	// `creating` falls back to 0 once the create resolves.
	let after = findPoint<number>(rm, 'ydb.query.session.count', {
		'ydb.session.state': 'creating',
		'db.namespace': '/local',
	})
	expect(after.value).toBe(0)
})

test('records ydb.query.session.acquire.duration', async () => {
	let acquireCh = tracingChannel('tracing:ydb:query.session.acquire')
	await acquireCh.tracePromise(async () => {}, { driver: driverIdentity })

	let rm = await collect()
	let point = findPoint<HistogramData>(rm, 'ydb.query.session.acquire.duration', {
		'db.namespace': '/local',
	})
	expect(point.value.count).toBe(1)
})

test('counts ydb.query.session.acquire.failures with error.type on acquire.failed', async () => {
	let err = new Error('pool full')
	err.name = 'SessionPoolFullError'
	channel('ydb:query.session.acquire.failed').publish({ driver: driverIdentity, error: err })

	let rm = await collect()
	let point = findPoint<number>(rm, 'ydb.query.session.acquire.failures', {
		'error.type': 'SessionPoolFullError',
		'db.namespace': '/local',
	})
	expect(point.value).toBe(1)
})

test('observes ydb.query.session.acquire.pending from waiter enqueue/dequeue events', async () => {
	channel('ydb:query.session.pool.opened').publish({
		driver: driverIdentity,
		maxSize: 5,
		minSize: 0,
	})
	channel('ydb:query.session.waiter.enqueued').publish({ driver: driverIdentity })
	channel('ydb:query.session.waiter.enqueued').publish({ driver: driverIdentity })
	channel('ydb:query.session.waiter.enqueued').publish({ driver: driverIdentity })
	channel('ydb:query.session.waiter.dequeued').publish({ driver: driverIdentity })

	let rm = await collect()
	let pending = findPoint<number>(rm, 'ydb.query.session.acquire.pending', {
		'db.namespace': '/local',
	})
	expect(pending.value).toBe(2)
})

test('observes ydb.query.session.max and ydb.query.session.min from pool.opened snapshot', async () => {
	channel('ydb:query.session.pool.opened').publish({
		driver: driverIdentity,
		maxSize: 42,
		minSize: 7,
	})

	let rm = await collect()
	let max = findPoint<number>(rm, 'ydb.query.session.max', { 'db.namespace': '/local' })
	let min = findPoint<number>(rm, 'ydb.query.session.min', { 'db.namespace': '/local' })
	expect(max.value).toBe(42)
	expect(min.value).toBe(7)
})

test('records ydb.auth.token.fetch.duration tagged by provider', async () => {
	let fetchCh = tracingChannel('tracing:ydb:auth.token.fetch')
	await fetchCh.tracePromise(async () => {}, { provider: 'metadata' })

	let rm = await collect()
	let point = findPoint<HistogramData>(rm, 'ydb.auth.token.fetch.duration', {
		'ydb.auth.provider': 'metadata',
	})
	expect(point.value.count).toBe(1)
})

test('records ydb.retry.duration tagged by outcome', async () => {
	let runCh = tracingChannel<{ idempotent: boolean; outcome?: string }, never>(
		'tracing:ydb:retry.run'
	)
	let ctx = { idempotent: true, outcome: undefined as string | undefined }
	await runCh.tracePromise(async () => {
		ctx.outcome = 'success'
	}, ctx)

	let rm = await collect()
	let point = findPoint<HistogramData>(rm, 'ydb.retry.duration', {
		'ydb.retry.outcome': 'success',
		'ydb.idempotent': true,
	})
	expect(point.value.count).toBe(1)
})

test('driver.closed drops both connection and session pool state for that driver', async () => {
	channel('ydb:driver.connection.added').publish({ driver: driverIdentity, nodeId: 1n })
	channel('ydb:driver.connection.added').publish({ driver: driverIdentity, nodeId: 2n })
	channel('ydb:query.session.pool.opened').publish({
		driver: driverIdentity,
		maxSize: 4,
		minSize: 0,
	})
	channel('ydb:query.session.created').publish({
		driver: driverIdentity,
		sessionId: 's1',
		nodeId: 1n,
	})

	channel('ydb:driver.closed').publish({ driver: driverIdentity })

	// Both registries are gone, so newly-published events start the counters
	// from zero rather than accumulating on top of the prior driver lifetime.
	channel('ydb:driver.connection.added').publish({ driver: driverIdentity, nodeId: 9n })
	channel('ydb:query.session.pool.opened').publish({
		driver: driverIdentity,
		maxSize: 10,
		minSize: 2,
	})

	let rm = await collect()
	let live = findPoint<number>(rm, 'ydb.driver.connection.count', {
		'ydb.connection.state': 'live',
		'db.namespace': '/local',
	})
	expect(live.value).toBe(1)
	let max = findPoint<number>(rm, 'ydb.query.session.max', { 'db.namespace': '/local' })
	expect(max.value).toBe(10)
	let idle = findPoint<number>(rm, 'ydb.query.session.count', {
		'ydb.session.state': 'idle',
		'db.namespace': '/local',
	})
	expect(idle.value).toBe(0)
})
