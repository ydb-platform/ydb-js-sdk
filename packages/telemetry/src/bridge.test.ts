// Bridge (2DC) topology mappings. These live under src/ rather than tests/
// because a multi-pile roster is unreachable on the single-node local YDB the
// integration suite spins up — the pile states can only be driven by publishing
// the diagnostics_channel payloads directly.

import { channel, tracingChannel } from 'node:diagnostics_channel'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { metrics, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { YdbInstrumentation } from './index.ts'
import {
	type MetricHarness,
	createMetricHarness,
	driverIdentity,
	findPoint,
	pointsFor,
} from './telemetry.fixtures.ts'

let spanExporter = new InMemorySpanExporter()
let tracerProvider: NodeTracerProvider
let harness: MetricHarness
let instrumentation: YdbInstrumentation

beforeEach(() => {
	spanExporter.reset()
	// Registered per-test and torn down in afterEach: the tracer provider is a
	// process-wide global, so a module-level register() that is never undone
	// would leak into any other test file sharing the worker.
	tracerProvider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(spanExporter)],
	})
	tracerProvider.register()
	harness = createMetricHarness()
	metrics.setGlobalMeterProvider(harness.provider)
	instrumentation = new YdbInstrumentation()
	instrumentation.enable()
})

afterEach(async () => {
	instrumentation.disable()
	await harness.shutdown()
	metrics.disable()
	trace.disable()
})

let collect = () => harness.collect()

function discoverySpan() {
	return spanExporter.getFinishedSpans().find((s) => s.name === 'ydb.Discovery')!
}

// --- trace-event mappings (fire inside the discovery span) -----------------

test('sets discovery self_location and primary_pile on the Discovery span', async () => {
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

	let span = discoverySpan()
	expect(span.attributes['ydb.discovery.self_location']).toBe('pile-a')
	expect(span.attributes['ydb.discovery.primary_pile']).toBe('pile-a')
	expect(span.attributes['ydb.discovery.total_count']).toBe(3)
})

test('omits primary_pile and self_location when the server reports neither', async () => {
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

	let span = discoverySpan()
	// Positive control: without it this test would also pass if the whole
	// discovery.completed mapping were disconnected.
	expect(span.attributes['ydb.discovery.total_count']).toBe(2)
	expect(span.attributes).not.toHaveProperty('ydb.discovery.self_location')
	expect(span.attributes).not.toHaveProperty('ydb.discovery.primary_pile')
})

test('records pile.changed as a span event with primary before/after and both rosters', async () => {
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

	let event = discoverySpan().events.find((e) => e.name === 'ydb.driver.pile.changed')!
	expect(event.attributes?.['ydb.driver.pile.primary_before']).toBe('pile-a')
	expect(event.attributes?.['ydb.driver.pile.primary_after']).toBe('pile-b')
	expect(event.attributes?.['ydb.driver.pile.before']).toEqual(['pile-a:PRIMARY'])
	expect(event.attributes?.['ydb.driver.pile.after']).toEqual([
		'pile-a:SYNCHRONIZED',
		'pile-b:PRIMARY',
	])
})

test('keeps the roster on a status-only change that leaves no primary pile', async () => {
	let discovery = tracingChannel('tracing:ydb:driver.discovery')
	await discovery.tracePromise(
		async () => {
			channel('ydb:driver.pile.changed').publish({
				driver: driverIdentity,
				selfLocation: 'pile-a',
				before: [{ name: 'pile-a', status: 'SYNCHRONIZED' }],
				after: [
					{ name: 'pile-a', status: 'SYNCHRONIZED' },
					{ name: 'pile-b', status: 'DISCONNECTED' },
				],
				primaryBefore: undefined,
				primaryAfter: undefined,
			})
		},
		{ driver: driverIdentity }
	)

	// `addEvent` (unlike `setAttributes`) keeps undefined-valued keys, so the
	// absent primaries must be stripped rather than shipped as empty values —
	// and the roster is what carries the signal in this window.
	let event = discoverySpan().events.find((e) => e.name === 'ydb.driver.pile.changed')!
	expect(Object.keys(event.attributes ?? {})).toEqual([
		'ydb.driver.pile.before',
		'ydb.driver.pile.after',
	])
	expect(event.attributes?.['ydb.driver.pile.after']).toEqual([
		'pile-a:SYNCHRONIZED',
		'pile-b:DISCONNECTED',
	])
})

test('omits ydb.node.pile from connection events off a bridge cluster', async () => {
	let discovery = tracingChannel('tracing:ydb:driver.discovery')
	await discovery.tracePromise(
		async () => {
			channel('ydb:driver.connection.added').publish({
				driver: driverIdentity,
				nodeId: 7n,
				address: '10.0.0.1:2135',
				location: 'dc1',
				pile: '',
			})
		},
		{ driver: driverIdentity }
	)

	let event = discoverySpan().events.find((e) => e.name === 'ydb.driver.connection.added')!
	expect(event.attributes?.['ydb.node.dc']).toBe('dc1')
	expect(Object.keys(event.attributes ?? {})).not.toContain('ydb.node.pile')
})

test('drops pile.changed when no span is active', async () => {
	channel('ydb:driver.pile.changed').publish({
		driver: driverIdentity,
		selfLocation: 'pile-a',
		before: [],
		after: [{ name: 'pile-a', status: 'PRIMARY' }],
		primaryBefore: undefined,
		primaryAfter: 'pile-a',
	})

	expect(spanExporter.getFinishedSpans()).toHaveLength(0)
})

// --- metric mappings (fire outside any span) -------------------------------

test('observes pool routable split by tier, with the routing mode on its own gauge', async () => {
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

	let rm = (await collect())!
	expect(
		findPoint<number>(rm, 'ydb.driver.pool.routable', { 'ydb.routing.tier': 'prefer' }).value
	).toBe(3)
	expect(
		findPoint<number>(rm, 'ydb.driver.pool.routable', { 'ydb.routing.tier': 'fallback' }).value
	).toBe(1)
	expect(findPoint<number>(rm, 'ydb.driver.pool.total', {}).value).toBe(5)

	// The mode rides a dedicated info gauge; putting it on `routable` would make
	// the series shape depend on whether pool.opened was observed.
	let cfg = findPoint<number>(rm, 'ydb.driver.pool.config', {})
	expect(cfg.value).toBe(1)
	expect(cfg.attributes['ydb.routing.locality_enabled']).toBe(true)
	expect(cfg.attributes['ydb.routing.prefer_primary_pile']).toBe(false)
	expect(pointsFor(rm, 'ydb.driver.pool.routable')[0]!.attributes).not.toHaveProperty(
		'ydb.routing.locality_enabled'
	)
})

test('keeps one routable series shape when pool.opened was missed', async () => {
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 2,
		prefer: 2,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})

	let rm = (await collect())!
	let prefer = findPoint<number>(rm, 'ydb.driver.pool.routable', { 'ydb.routing.tier': 'prefer' })
	expect(prefer.value).toBe(2)
	// Zero-valued series must still be reported — absent-vs-zero is what
	// alerting keys off.
	expect(
		findPoint<number>(rm, 'ydb.driver.pool.routable', { 'ydb.routing.tier': 'fallback' }).value
	).toBe(0)
	expect(findPoint<number>(rm, 'ydb.driver.pool.pessimized', {}).value).toBe(0)
	// No pool.opened means no config gauge, not a differently-shaped routable.
	expect(pointsFor(rm, 'ydb.driver.pool.config')).toHaveLength(0)
})

test('observes pool nodes per pile and leaves the gauge empty off a bridge cluster', async () => {
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

	let rm = (await collect())!
	expect(
		findPoint<number>(rm, 'ydb.driver.pool.nodes', { 'ydb.pile.name': 'pile-a' }).value
	).toBe(3)
	expect(
		findPoint<number>(rm, 'ydb.driver.pool.nodes', { 'ydb.pile.name': 'pile-b' }).value
	).toBe(2)
	// Status is never a dimension of the COUNT; it lives on the state-set gauge.
	expect(pointsFor(rm, 'ydb.driver.pool.nodes')[0]!.attributes).not.toHaveProperty(
		'ydb.pile.status'
	)
	expect(
		findPoint<number>(rm, 'ydb.driver.pile.status', {
			'ydb.pile.name': 'pile-a',
			'ydb.pile.status': 'PRIMARY',
		}).value
	).toBe(1)
	expect(
		findPoint<number>(rm, 'ydb.driver.pile.status', {
			'ydb.pile.name': 'pile-a',
			'ydb.pile.status': 'DISCONNECTED',
		}).value
	).toBe(0)
})

test('reports no pile nodes when the roster is empty', async () => {
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 2,
		prefer: 2,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})

	expect(pointsFor(await collect(), 'ydb.driver.pool.nodes')).toHaveLength(0)
})

test('does not fork pool nodes series across a bridge failover', async () => {
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
	await collect()

	// Failover: the piles swap roles, the node count is unchanged.
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 5,
		prefer: 2,
		fallback: 3,
		pessimized: 0,
		piles: [
			{ name: 'pile-a', status: 'SYNCHRONIZED', nodes: 3 },
			{ name: 'pile-b', status: 'PRIMARY', nodes: 2 },
		],
	})

	// Cumulative temporality never retires an attribute set that stops being
	// observed, so a mutable tag on the COUNT would leave the pre-failover series
	// frozen alongside the new one and double the sum.
	let rm = await collect()
	let nodes = pointsFor<number>(rm, 'ydb.driver.pool.nodes')
	expect(nodes).toHaveLength(2)
	expect(nodes.reduce((sum, p) => sum + p.value, 0)).toBe(5)

	// The state set tracks the transition: exactly one pile reads PRIMARY, and
	// the pre-failover pair is overwritten with 0 rather than stranded at 1.
	let primary = pointsFor<number>(rm, 'ydb.driver.pile.status', {
		'ydb.pile.status': 'PRIMARY',
	})
	expect(primary.filter((p) => p.value === 1).map((p) => p.attributes['ydb.pile.name'])).toEqual([
		'pile-b',
	])
	expect(
		findPoint<number>(rm!, 'ydb.driver.pile.status', {
			'ydb.pile.name': 'pile-a',
			'ydb.pile.status': 'PRIMARY',
		}).value
	).toBe(0)
})

test('zeroes a pile that leaves the roster instead of freezing its last count', async () => {
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
	await collect()

	// pile-b is decommissioned and disappears from the roster entirely.
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 3,
		prefer: 3,
		fallback: 0,
		pessimized: 0,
		piles: [{ name: 'pile-a', status: 'PRIMARY', nodes: 3 }],
	})

	let rm = await collect()
	expect(
		findPoint<number>(rm!, 'ydb.driver.pool.nodes', { 'ydb.pile.name': 'pile-b' }).value
	).toBe(0)
	expect(
		pointsFor<number>(rm, 'ydb.driver.pile.status', { 'ydb.pile.name': 'pile-b' }).every(
			(p) => p.value === 0
		)
	).toBe(true)
	expect(
		pointsFor<number>(rm, 'ydb.driver.pool.nodes').reduce((sum, p) => sum + p.value, 0)
	).toBe(3)
})

test('counts pile fallbacks tagged by direction', async () => {
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

	let rm = (await collect())!
	expect(
		findPoint<number>(rm, 'ydb.driver.pile.fallbacks', { 'ydb.pile.fallback.active': true })
			.value
	).toBe(1)
	expect(
		findPoint<number>(rm, 'ydb.driver.pile.fallbacks', { 'ydb.pile.fallback.active': false })
			.value
	).toBe(1)
})

test('counts pile changes', async () => {
	channel('ydb:driver.pile.changed').publish({
		driver: driverIdentity,
		selfLocation: 'pile-a',
		before: [],
		after: [{ name: 'pile-a', status: 'PRIMARY' }],
		primaryBefore: undefined,
		primaryAfter: 'pile-a',
	})

	expect(findPoint<number>((await collect())!, 'ydb.driver.pile.changes', {}).value).toBe(1)
})

test('stops observing pool gauges for a driver after driver.closed', async () => {
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 3,
		prefer: 3,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})
	// Collect BEFORE the close: a series that was never exported would be
	// trivially absent afterwards regardless of the registry.
	expect(pointsFor(await collect(), 'ydb.driver.pool.routable')).toHaveLength(2)

	channel('ydb:driver.closed').publish({ driver: driverIdentity })
	channel('ydb:driver.connection.pool.stats').publish({
		driver: { address: '10.0.0.9', port: 2136, database: '/other' },
		total: 2,
		prefer: 2,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})

	let rm = await collect()
	expect(
		findPoint<number>(rm!, 'ydb.driver.pool.routable', {
			'db.namespace': '/other',
			'ydb.routing.tier': 'prefer',
		}).value
	).toBe(2)
	// The registry entry is gone, so the closed driver is no longer OBSERVED.
	// Its already-exported series is still carried forward by the SDK under
	// cumulative temporality — see the README note on closed drivers.
	expect(pointsFor(rm, 'ydb.driver.pool.routable', { 'db.namespace': '/local' })).toHaveLength(2)
})

test('leaves connection.count unreported for a driver known only from pool events', async () => {
	channel('ydb:driver.connection.pool.opened').publish({
		driver: driverIdentity,
		config: { localityEnabled: false, preferPrimaryPile: true },
	})
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 8,
		prefer: 8,
		fallback: 0,
		pessimized: 0,
		piles: [],
	})

	// A late subscriber missed every connection.added, so a zero here would be a
	// confident lie about a driver that actually has 8 live connections.
	let rm = await collect()
	expect(pointsFor(rm, 'ydb.driver.connection.count')).toHaveLength(0)
	expect(findPoint<number>(rm!, 'ydb.driver.pool.total', {}).value).toBe(8)
})

test('survives a pool.stats payload with no config or piles', async () => {
	channel('ydb:driver.connection.pool.opened').publish({ driver: driverIdentity })
	channel('ydb:driver.connection.pool.stats').publish({
		driver: driverIdentity,
		total: 1,
		prefer: 1,
		fallback: 0,
		pessimized: 0,
	})
	// A malformed payload must not escape the subscriber (diagnostics_channel
	// re-raises a throw as an uncaughtException) nor blank the whole batch.
	channel('ydb:query.session.pool.opened').publish({
		driver: driverIdentity,
		maxSize: 4,
		minSize: 1,
	})

	let rm = await collect()
	expect(findPoint<number>(rm!, 'ydb.driver.pool.total', {}).value).toBe(1)
	expect(findPoint<number>(rm!, 'ydb.query.session.max', {}).value).toBe(4)
})
