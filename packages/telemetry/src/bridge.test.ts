import { channel, tracingChannel } from 'node:diagnostics_channel'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { type MetricAttributes, metrics } from '@opentelemetry/api'
import {
	AggregationTemporality,
	type DataPoint,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { YdbInstrumentation } from './index.ts'

// One instrumentation feeds both pipelines: the trace-event mappings read the
// span exporter, the metric mappings read the metric reader. The tracer
// provider is registered once (its global is process-wide); the meter provider
// is rebuilt per test so cumulative counters start from zero each time.
let spanExporter = new InMemorySpanExporter()
let tracerProvider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(spanExporter)],
})
tracerProvider.register()

let metricExporter: InMemoryMetricExporter
let metricReader: PeriodicExportingMetricReader
let meterProvider: MeterProvider
let instrumentation: YdbInstrumentation

beforeEach(() => {
	spanExporter.reset()
	metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
	metricReader = new PeriodicExportingMetricReader({
		exporter: metricExporter,
		exportIntervalMillis: 60_000,
		exportTimeoutMillis: 5_000,
	})
	meterProvider = new MeterProvider({ readers: [metricReader] })
	metrics.setGlobalMeterProvider(meterProvider)
	instrumentation = new YdbInstrumentation()
	instrumentation.enable()
})

afterEach(async () => {
	instrumentation.disable()
	await meterProvider.shutdown()
	metrics.disable()
})

let driverIdentity = {
	address: '127.0.0.1',
	port: 2136,
	database: '/local',
	registeredAt: 0,
}

async function collect(): Promise<ResourceMetrics> {
	await meterProvider.forceFlush()
	let exported = metricExporter.getMetrics()
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

// --- trace-event mappings (fire inside the discovery span) -----------------

test('sets discovery self_location and primary_pile on the Discovery span from discovery.completed', async () => {
	let discovery = tracingChannel('tracing:ydb:driver.discovery')
	await discovery.tracePromise(
		async () => {
			channel('ydb:driver.discovery.completed').publish({
				driver: driverIdentity,
				addedCount: 1,
				removedCount: 0,
				totalCount: 3,
				duration: 1200,
				selfLocation: 'pile-a',
				primaryPile: 'pile-a',
				piles: [{ name: 'pile-a', status: 'PRIMARY' }],
			})
		},
		{ driver: driverIdentity }
	)

	let span = spanExporter.getFinishedSpans().find((s) => s.name === 'ydb.Discovery')!
	expect(span.attributes['ydb.discovery.self_location']).toBe('pile-a')
	expect(span.attributes['ydb.discovery.primary_pile']).toBe('pile-a')
	expect(span.attributes['ydb.discovery.total_count']).toBe(3)
})

test('omits discovery self_location and primary_pile off a non-bridge cluster', async () => {
	let discovery = tracingChannel('tracing:ydb:driver.discovery')
	await discovery.tracePromise(
		async () => {
			channel('ydb:driver.discovery.completed').publish({
				driver: driverIdentity,
				addedCount: 0,
				removedCount: 0,
				totalCount: 2,
				duration: 800,
				selfLocation: '',
				primaryPile: undefined,
				piles: [],
			})
		},
		{ driver: driverIdentity }
	)

	let span = spanExporter.getFinishedSpans().find((s) => s.name === 'ydb.Discovery')!
	expect(span.attributes['ydb.discovery.self_location']).toBeUndefined()
	expect(span.attributes['ydb.discovery.primary_pile']).toBeUndefined()
})

test('records pile.changed as a span event with primary before/after', async () => {
	let discovery = tracingChannel('tracing:ydb:driver.discovery')
	await discovery.tracePromise(
		async () => {
			channel('ydb:driver.pile.changed').publish({
				driver: driverIdentity,
				selfLocation: 'pile-a',
				before: [{ name: 'pile-a', status: 'PRIMARY' }],
				after: [
					{ name: 'pile-a', status: 'SYNCHRONIZED' },
					{ name: 'pile-b', status: 'PRIMARY' },
				],
				primaryBefore: 'pile-a',
				primaryAfter: 'pile-b',
			})
		},
		{ driver: driverIdentity }
	)

	let span = spanExporter.getFinishedSpans().find((s) => s.name === 'ydb.Discovery')!
	let event = span.events.find((e) => e.name === 'ydb.driver.pile.changed')
	expect(event).toBeDefined()
	expect(event!.attributes?.['ydb.driver.pile.primary_before']).toBe('pile-a')
	expect(event!.attributes?.['ydb.driver.pile.primary_after']).toBe('pile-b')
})

// --- metric mappings (fire outside any span) -------------------------------

test('observes ydb.driver.pool.routable split by tier with routing mode from pool.opened', async () => {
	channel('ydb:driver.connection.pool.opened').publish({
		driver: driverIdentity,
		config: {
			localityEnabled: true,
			preferPrimaryPile: false,
			degradedThreshold: 0.5,
			discoveryIntervalMs: 60_000,
			idleIntervalMs: 60_000,
			retiredGraceMs: 300_000,
			closeDeadlineMs: 10_000,
		},
	})
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 5,
		prefer: 3,
		fallback: 1,
		pessimized: 1,
		piles: [],
	})

	let rm = await collect()
	let prefer = findPoint<number>(rm, 'ydb.driver.pool.routable', {
		'ydb.routing.tier': 'prefer',
		'db.namespace': '/local',
	})
	let fallback = findPoint<number>(rm, 'ydb.driver.pool.routable', {
		'ydb.routing.tier': 'fallback',
	})
	expect(prefer.value).toBe(3)
	expect(fallback.value).toBe(1)
	// Config folded from pool.opened rides the routing gauge.
	expect(prefer.attributes['ydb.routing.locality_enabled']).toBe(true)
	expect(prefer.attributes['ydb.routing.prefer_primary_pile']).toBe(false)
})

test('observes ydb.driver.pool.routable without mode tags when pool.opened was missed', async () => {
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 2,
		prefer: 2,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})

	let rm = await collect()
	let prefer = findPoint<number>(rm, 'ydb.driver.pool.routable', { 'ydb.routing.tier': 'prefer' })
	expect(prefer.value).toBe(2)
	expect(prefer.attributes['ydb.routing.prefer_primary_pile']).toBeUndefined()
	expect(prefer.attributes['ydb.routing.locality_enabled']).toBeUndefined()
})

test('observes ydb.driver.pool.pessimized from pool.stats', async () => {
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 4,
		prefer: 2,
		fallback: 0,
		pessimized: 2,
		piles: [],
	})

	let rm = await collect()
	let point = findPoint<number>(rm, 'ydb.driver.pool.pessimized', { 'db.namespace': '/local' })
	expect(point.value).toBe(2)
})

test('observes ydb.driver.pool.nodes per pile from pool.stats', async () => {
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 5,
		prefer: 3,
		fallback: 2,
		pessimized: 0,
		piles: [
			{ name: 'pile-a', status: 'PRIMARY', nodes: 3 },
			{ name: 'pile-b', status: 'SYNCHRONIZED', nodes: 2 },
		],
	})

	let rm = await collect()
	let a = findPoint<number>(rm, 'ydb.driver.pool.nodes', {
		'ydb.pile.name': 'pile-a',
		'ydb.pile.status': 'PRIMARY',
	})
	let b = findPoint<number>(rm, 'ydb.driver.pool.nodes', {
		'ydb.pile.name': 'pile-b',
		'ydb.pile.status': 'SYNCHRONIZED',
	})
	expect(a.value).toBe(3)
	expect(b.value).toBe(2)
})

test('counts ydb.driver.pile.fallbacks tagged by active on pile.fallback', async () => {
	channel('ydb:driver.pile.fallback').publish({
		driver: driverIdentity,
		active: true,
		primaryPile: 'pile-a',
	})
	channel('ydb:driver.pile.fallback').publish({
		driver: driverIdentity,
		active: false,
		primaryPile: 'pile-a',
	})

	let rm = await collect()
	let entered = findPoint<number>(rm, 'ydb.driver.pile.fallbacks', {
		'ydb.pile.fallback.active': true,
	})
	let recovered = findPoint<number>(rm, 'ydb.driver.pile.fallbacks', {
		'ydb.pile.fallback.active': false,
	})
	expect(entered.value).toBe(1)
	expect(recovered.value).toBe(1)
})

test('counts ydb.driver.pile.changes on pile.changed', async () => {
	channel('ydb:driver.pile.changed').publish({
		driver: driverIdentity,
		selfLocation: 'pile-a',
		before: [],
		after: [{ name: 'pile-a', status: 'PRIMARY' }],
		primaryBefore: undefined,
		primaryAfter: 'pile-a',
	})

	let rm = await collect()
	let point = findPoint<number>(rm, 'ydb.driver.pile.changes', { 'db.namespace': '/local' })
	expect(point.value).toBe(1)
})

test('drops pool stats gauges for a driver on driver.closed', async () => {
	// A second, still-open driver keeps the instrument alive so this asserts the
	// closed driver's datapoints are dropped, not that all metrics vanished.
	let other = { address: '10.0.0.9', port: 2136, database: '/other', registeredAt: 1 }
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 3,
		prefer: 3,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})
	channel('ydb:driver.connection.pool.stats').publish({
		driver: other,
		total: 2,
		prefer: 2,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})
	channel('ydb:driver.closed').publish({ driver: driverIdentity })

	let rm = await collect()
	// The surviving driver still reports; the closed one's entry is gone.
	let survivor = findPoint<number>(rm, 'ydb.driver.pool.routable', {
		'db.namespace': '/other',
		'ydb.routing.tier': 'prefer',
	})
	expect(survivor.value).toBe(2)
	let closed = rm.scopeMetrics
		.flatMap((s) => s.metrics)
		.filter((m) => m.descriptor.name === 'ydb.driver.pool.routable')
		.flatMap((m) => m.dataPoints)
		.filter((p) => (p.attributes as Record<string, unknown>)['db.namespace'] === '/local')
	expect(closed).toHaveLength(0)
})
