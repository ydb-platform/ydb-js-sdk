/**
 * Tests for tracing channel subscribers that were not covered by existing test files:
 *   - tracing/driver.ts   → ydb.DriverInit span
 *   - tracing/discovery.ts → ydb.Discovery span + ydb:discovery.completed enrichment
 *   - tracing/auth.ts     → ydb.TokenFetch span
 *   - tracing/pool.ts     → ydb.pool.connection.* spans (plain channels)
 *   - tracing/query.ts    → ydb.Begin, ydb.Commit, ydb.Rollback spans
 */
import { channel, tracingChannel } from 'node:diagnostics_channel'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { SPAN_NAMES, createOpenTelemetryTracer, installTracing } from '../src/index.ts'

// ---------------------------------------------------------------------------
// Shared OTel plumbing — one provider, one exporter for the whole file.
// ---------------------------------------------------------------------------

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

let unsub: () => void

beforeAll(() => {
	let disposers = installTracing({
		tracer: createOpenTelemetryTracer(),
		endpoint: 'grpc://127.0.0.1:2136/local',
	})
	unsub = () => {
		for (let d of disposers) d()
	}
})

afterAll(() => {
	unsub()
})

beforeEach(() => {
	exporter.reset()
})

// ---------------------------------------------------------------------------
// driver.ts — tracing:ydb:driver.init
// ---------------------------------------------------------------------------

let driverInitCh = tracingChannel<{
	database: string
	endpoint: string
	discovery: boolean
	error?: unknown
}>('tracing:ydb:driver.init')

test('creates ydb.DriverInit span with correct attributes', async () => {
	await driverInitCh.tracePromise(async () => {}, {
		database: '/local',
		endpoint: '127.0.0.1:2136',
		discovery: true,
	})

	let spans = exporter.getFinishedSpans()
	let span = spans.find((s) => s.name === SPAN_NAMES.DriverInit)
	expect(span).toBeDefined()
	expect(span!.attributes['db.operation.name']).toBe('DriverInit')
	expect(span!.attributes['db.namespace']).toBe('/local')
	expect(span!.attributes['server.address']).toBe('127.0.0.1:2136')
	expect(span!.attributes['ydb.discovery.enabled']).toBe(true)
})

test('ydb.DriverInit has db.system.name = ydb', async () => {
	await driverInitCh.tracePromise(async () => {}, {
		database: '/my-db',
		endpoint: 'grpc-host:2135',
		discovery: false,
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.DriverInit)
	expect(span).toBeDefined()
	expect(span!.attributes['db.system.name']).toBe('ydb')
	expect(span!.attributes['ydb.discovery.enabled']).toBe(false)
})

test('ydb.DriverInit sets error status when driver init fails', async () => {
	let err = new Error('connection refused')
	await expect(
		driverInitCh.tracePromise(
			async () => {
				throw err
			},
			{ database: '/local', endpoint: '127.0.0.1:2136', discovery: false }
		)
	).rejects.toThrow('connection refused')

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.DriverInit)
	expect(span).toBeDefined()
	expect(span!.status?.code).toBe(2)
	expect(span!.attributes['error.type']).toBeDefined()
})

test('ydb.DriverInit is a leaf span (does not set active subscriber span)', async () => {
	let activeSpanDuringInit: unknown
	await driverInitCh.tracePromise(
		async () => {
			// enterLeaf does NOT push to spanStorage, so active subscriber span stays undefined
			const { getActiveSubscriberSpan } = await import('../src/context-manager.ts')
			activeSpanDuringInit = getActiveSubscriberSpan()
		},
		{ database: '/local', endpoint: '127.0.0.1:2136', discovery: true }
	)

	// The outer ALS has no span, enterLeaf does not change it
	expect(activeSpanDuringInit).toBeUndefined()
})

// ---------------------------------------------------------------------------
// discovery.ts — tracing:ydb:discovery + ydb:discovery.completed
// ---------------------------------------------------------------------------

let discoveryCh = tracingChannel<{
	database: string
	periodic: boolean
	error?: unknown
}>('tracing:ydb:discovery')

let discoveryCompletedCh = channel('ydb:discovery.completed')

test('creates ydb.Discovery span with correct attributes', async () => {
	await discoveryCh.tracePromise(async () => {}, {
		database: '/local',
		periodic: false,
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Discovery)
	expect(span).toBeDefined()
	expect(span!.attributes['db.operation.name']).toBe('Discovery')
	expect(span!.attributes['db.namespace']).toBe('/local')
	expect(span!.attributes['ydb.discovery.periodic']).toBe(false)
	expect(span!.attributes['db.system.name']).toBe('ydb')
})

test('periodic discovery flag is recorded', async () => {
	await discoveryCh.tracePromise(async () => {}, {
		database: '/local',
		periodic: true,
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Discovery)
	expect(span).toBeDefined()
	expect(span!.attributes['ydb.discovery.periodic']).toBe(true)
})

test('ydb:discovery.completed enriches the active Discovery span with endpoint counts', async () => {
	await discoveryCh.tracePromise(
		async () => {
			discoveryCompletedCh.publish({
				database: '/local',
				addedCount: 3,
				removedCount: 1,
				totalCount: 5,
				duration: 42,
			})
		},
		{ database: '/local', periodic: false }
	)

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Discovery)
	expect(span).toBeDefined()
	expect(span!.attributes['ydb.discovery.added_count']).toBe(3)
	expect(span!.attributes['ydb.discovery.removed_count']).toBe(1)
	expect(span!.attributes['ydb.discovery.total_count']).toBe(5)
	expect(span!.attributes['ydb.discovery.duration_ms']).toBe(42)
})

test('ydb:discovery.completed without active span does not throw', () => {
	// Fire the plain channel outside any tracePromise — no active subscriber span.
	expect(() => {
		discoveryCompletedCh.publish({
			database: '/local',
			addedCount: 0,
			removedCount: 0,
			totalCount: 0,
			duration: 0,
		})
	}).not.toThrow()
})

test('ydb.Discovery sets error status on failure', async () => {
	await expect(
		discoveryCh.tracePromise(
			async () => {
				throw new Error('no endpoints')
			},
			{ database: '/local', periodic: false }
		)
	).rejects.toThrow('no endpoints')

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Discovery)
	expect(span).toBeDefined()
	expect(span!.status?.code).toBe(2)
})

// ---------------------------------------------------------------------------
// auth.ts — tracing:ydb:auth.token.fetch
// ---------------------------------------------------------------------------

let tokenFetchCh = tracingChannel<{
	provider: 'static' | 'metadata' | 'iam' | 'access_token' | 'anonymous'
	error?: unknown
}>('tracing:ydb:auth.token.fetch')

test('creates ydb.TokenFetch span with auth provider attribute', async () => {
	await tokenFetchCh.tracePromise(async () => {}, { provider: 'iam' })

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.TokenFetch)
	expect(span).toBeDefined()
	expect(span!.attributes['db.operation.name']).toBe('TokenFetch')
	expect(span!.attributes['ydb.auth.provider']).toBe('iam')
	expect(span!.attributes['db.system.name']).toBe('ydb')
})

test.each(['static', 'metadata', 'iam', 'access_token', 'anonymous'] as const)(
	'records provider=%s on the span',
	async (provider) => {
		exporter.reset()
		await tokenFetchCh.tracePromise(async () => {}, { provider })

		let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.TokenFetch)
		expect(span).toBeDefined()
		expect(span!.attributes['ydb.auth.provider']).toBe(provider)
	}
)

test('ydb.TokenFetch sets error status when token fetch fails', async () => {
	await expect(
		tokenFetchCh.tracePromise(
			async () => {
				throw new Error('auth failed')
			},
			{ provider: 'metadata' }
		)
	).rejects.toThrow('auth failed')

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.TokenFetch)
	expect(span).toBeDefined()
	expect(span!.status?.code).toBe(2)
	expect(span!.attributes['error.type']).toBeDefined()
})

// ---------------------------------------------------------------------------
// pool.ts — ydb:pool.connection.* (plain diagnostics channels)
// ---------------------------------------------------------------------------

let connectionAddedCh = channel('ydb:pool.connection.added')
let connectionPessimizedCh = channel('ydb:pool.connection.pessimized')
let connectionUnpessimizedCh = channel('ydb:pool.connection.unpessimized')
let connectionRetiredCh = channel('ydb:pool.connection.retired')
let connectionRemovedCh = channel('ydb:pool.connection.removed')

test('ydb:pool.connection.added creates span with node attributes', () => {
	connectionAddedCh.publish({
		nodeId: 42n,
		address: '10.0.0.1:2136',
		location: 'sas',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.pool.connection.added')
	expect(span).toBeDefined()
	expect(span!.attributes['ydb.node.id']).toBe(42)
	expect(span!.attributes['network.peer.address']).toBe('10.0.0.1:2136')
	expect(span!.attributes['ydb.node.dc']).toBe('sas')
})

test('ydb:pool.connection.pessimized creates span', () => {
	connectionPessimizedCh.publish({
		nodeId: 7n,
		address: '10.0.0.7:2136',
		location: 'vla',
		until: Date.now() + 60_000,
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.pool.connection.pessimized')
	expect(span).toBeDefined()
	expect(span!.attributes['ydb.node.id']).toBe(7)
	expect(span!.attributes['network.peer.address']).toBe('10.0.0.7:2136')
	expect(span!.attributes['ydb.node.dc']).toBe('vla')
})

test('ydb:pool.connection.unpessimized creates span with pessimization duration', () => {
	connectionUnpessimizedCh.publish({
		nodeId: 3n,
		address: '10.0.0.3:2136',
		location: 'iva',
		duration: 5000,
	})

	let span = exporter
		.getFinishedSpans()
		.find((s) => s.name === 'ydb.pool.connection.unpessimized')
	expect(span).toBeDefined()
	expect(span!.attributes['ydb.node.id']).toBe(3)
	expect(span!.attributes['ydb.pool.pessimization.duration_ms']).toBe(5000)
})

test('ydb:pool.connection.retired creates span with retire reason', () => {
	connectionRetiredCh.publish({
		nodeId: 11n,
		address: '10.0.0.11:2136',
		location: 'myt',
		reason: 'overloaded',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.pool.connection.retired')
	expect(span).toBeDefined()
	expect(span!.attributes['ydb.pool.retire.reason']).toBe('overloaded')
	expect(span!.attributes['ydb.node.id']).toBe(11)
})

test('ydb:pool.connection.removed creates span with remove reason', () => {
	connectionRemovedCh.publish({
		nodeId: 5n,
		address: '10.0.0.5:2136',
		location: 'sas',
		reason: 'unhealthy',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.pool.connection.removed')
	expect(span).toBeDefined()
	expect(span!.attributes['ydb.pool.remove.reason']).toBe('unhealthy')
	expect(span!.attributes['ydb.node.id']).toBe(5)
})

test('pool spans all finish immediately (zero-duration leaf spans)', () => {
	connectionAddedCh.publish({ nodeId: 1n, address: 'a:2136', location: 'dc1' })
	connectionPessimizedCh.publish({
		nodeId: 2n,
		address: 'b:2136',
		location: 'dc2',
		until: 0,
	})
	connectionUnpessimizedCh.publish({
		nodeId: 3n,
		address: 'c:2136',
		location: 'dc3',
		duration: 0,
	})
	connectionRetiredCh.publish({ nodeId: 4n, address: 'd:2136', location: 'dc4', reason: 'r' })
	connectionRemovedCh.publish({ nodeId: 5n, address: 'e:2136', location: 'dc5', reason: 'x' })

	let spans = exporter.getFinishedSpans()
	let poolSpanNames = spans.map((s) => s.name).filter((n) => n.startsWith('ydb.pool'))
	expect(poolSpanNames).toHaveLength(5)
})

// ---------------------------------------------------------------------------
// query.ts — ydb.Begin, ydb.Commit, ydb.Rollback spans
// ---------------------------------------------------------------------------

let beginCh = tracingChannel<{
	sessionId: string
	nodeId: bigint
	isolation: string
	error?: unknown
}>('tracing:ydb:query.begin')

let commitCh = tracingChannel<{
	sessionId: string
	transactionId: string
	error?: unknown
}>('tracing:ydb:query.commit')

let rollbackCh = tracingChannel<{
	sessionId: string
	transactionId: string
	error?: unknown
}>('tracing:ydb:query.rollback')

test('creates ydb.Begin span with isolation and session attributes', async () => {
	await beginCh.tracePromise(async () => {}, {
		sessionId: 'sess-begin-1',
		nodeId: 10n,
		isolation: 'serializableReadWrite',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Begin)
	expect(span).toBeDefined()
	expect(span!.attributes['db.operation.name']).toBe('BeginTransaction')
	expect(span!.attributes['db.ydb.session_id']).toBe('sess-begin-1')
	expect(span!.attributes['db.ydb.node_id']).toBe(10)
	expect(span!.attributes['ydb.isolation']).toBe('serializableReadWrite')
	expect(span!.attributes['db.system.name']).toBe('ydb')
})

test('ydb.Begin sets error status on failure', async () => {
	await expect(
		beginCh.tracePromise(
			async () => {
				throw new Error('begin failed')
			},
			{ sessionId: 'sess-begin-err', nodeId: 1n, isolation: 'serializableReadWrite' }
		)
	).rejects.toThrow('begin failed')

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Begin)
	expect(span).toBeDefined()
	expect(span!.status?.code).toBe(2)
})

test('creates ydb.Commit span with transaction id', async () => {
	await commitCh.tracePromise(async () => {}, {
		sessionId: 'sess-commit-1',
		transactionId: 'tx-abc-123',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Commit)
	expect(span).toBeDefined()
	expect(span!.attributes['db.operation.name']).toBe('CommitTransaction')
	expect(span!.attributes['db.ydb.session_id']).toBe('sess-commit-1')
	expect(span!.attributes['ydb.transaction.id']).toBe('tx-abc-123')
})

test('ydb.Commit sets error status on failure', async () => {
	await expect(
		commitCh.tracePromise(
			async () => {
				throw new Error('commit failed')
			},
			{ sessionId: 'sess-commit-err', transactionId: 'tx-err' }
		)
	).rejects.toThrow('commit failed')

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Commit)
	expect(span).toBeDefined()
	expect(span!.status?.code).toBe(2)
})

test('creates ydb.Rollback span with transaction id', async () => {
	await rollbackCh.tracePromise(async () => {}, {
		sessionId: 'sess-rb-1',
		transactionId: 'tx-rollback-xyz',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Rollback)
	expect(span).toBeDefined()
	expect(span!.attributes['db.operation.name']).toBe('RollbackTransaction')
	expect(span!.attributes['db.ydb.session_id']).toBe('sess-rb-1')
	expect(span!.attributes['ydb.transaction.id']).toBe('tx-rollback-xyz')
})

test('ydb.Rollback sets error status on failure', async () => {
	await expect(
		rollbackCh.tracePromise(
			async () => {
				throw new Error('rollback failed')
			},
			{ sessionId: 'sess-rb-err', transactionId: 'tx-rb-err' }
		)
	).rejects.toThrow('rollback failed')

	let span = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Rollback)
	expect(span).toBeDefined()
	expect(span!.status?.code).toBe(2)
})

test('ydb.Commit is a leaf span — does not become active subscriber span', async () => {
	let activeSpanDuringCommit: unknown
	await commitCh.tracePromise(
		async () => {
			const { getActiveSubscriberSpan } = await import('../src/context-manager.ts')
			activeSpanDuringCommit = getActiveSubscriberSpan()
		},
		{ sessionId: 'sess-commit-leaf', transactionId: 'tx-leaf' }
	)

	// enterLeaf does not push to spanStorage
	expect(activeSpanDuringCommit).toBeUndefined()
})

test('ydb.Begin, ydb.Commit appear as siblings inside ydb.Transaction', async () => {
	let transactionCh = tracingChannel<{ isolation: string; idempotent: boolean }>(
		'tracing:ydb:query.transaction'
	)

	await transactionCh.tracePromise(
		async () => {
			await beginCh.tracePromise(async () => {}, {
				sessionId: 'sess-tx-full',
				nodeId: 1n,
				isolation: 'serializableReadWrite',
			})
			await commitCh.tracePromise(async () => {}, {
				sessionId: 'sess-tx-full',
				transactionId: 'tx-full-1',
			})
		},
		{ isolation: 'serializableReadWrite', idempotent: false }
	)

	let spans = exporter.getFinishedSpans()
	let txSpan = spans.find((s) => s.name === SPAN_NAMES.Transaction)
	let beginSpan = spans.find((s) => s.name === SPAN_NAMES.Begin)
	let commitSpan = spans.find((s) => s.name === SPAN_NAMES.Commit)

	expect(txSpan).toBeDefined()
	expect(beginSpan).toBeDefined()
	expect(commitSpan).toBeDefined()

	// Both are leaf children of the Transaction span
	expect(beginSpan!.parentSpanContext?.spanId).toBe(txSpan!.spanContext().spanId)
	expect(commitSpan!.parentSpanContext?.spanId).toBe(txSpan!.spanContext().spanId)
})
