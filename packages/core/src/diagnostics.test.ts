import { expect, test } from 'vitest'
import { channel as dc, tracingChannel } from 'node:diagnostics_channel'
import { credentials } from '@grpc/grpc-js'
import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { ServerError, Status, createServer } from 'nice-grpc'
import {
	DiscoveryServiceDefinition,
	EndpointInfoSchema,
	ListEndpointsResultSchema,
} from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'

import { Driver } from './driver.js'
import { ConnectionPool, POOL_GET_ACTIVE_FOR_TESTING } from './pool.js'

function makeProtoEndpoint(nodeId: number, port = 2136) {
	return {
		nodeId,
		address: `node-${nodeId}`,
		port,
		location: 'dc1',
		sslTargetNameOverride: '',
	} as any
}

function makePool(opts: { pessimizationTimeout?: number } = {}) {
	return new ConnectionPool({
		channelCredentials: credentials.createInsecure(),
		idleTimeout: 0,
		idleInterval: 0,
		pessimizationTimeout: opts.pessimizationTimeout ?? 60_000,
	})
}

/**
 * Subscribe to a DC channel and collect deep-cloned payloads.
 * Returned object is `Disposable` — `using` auto-unsubscribes on scope exit.
 */
function collect(name: string): { payloads: unknown[] } & Disposable {
	let payloads: unknown[] = []
	let fn = (msg: unknown) => payloads.push(structuredClone(msg))
	dc(name).subscribe(fn)
	return {
		payloads,
		[Symbol.dispose]() {
			dc(name).unsubscribe(fn)
		},
	}
}

// ── added / removed via discovery ────────────────────────────────────────────

test('publishes ydb:pool.connection.added when sync introduces a new endpoint', () => {
	using pool = makePool()
	using added = collect('ydb:pool.connection.added')

	pool.sync([makeProtoEndpoint(1)])

	expect(added.payloads).toHaveLength(1)
	expect(added.payloads[0]).toMatchObject({
		nodeId: 1n,
		address: 'node-1:2136',
		location: 'dc1',
	})
})

test('publishes ydb:pool.connection.retired when an active endpoint disappears from discovery', () => {
	using pool = makePool()
	pool.sync([makeProtoEndpoint(1)])

	using retired = collect('ydb:pool.connection.retired')
	using removed = collect('ydb:pool.connection.removed')

	pool.sync([]) // node 1 is no longer in discovery

	// channel stays open until idle sweep → no `removed` yet
	expect(removed.payloads).toHaveLength(0)
	expect(retired.payloads).toHaveLength(1)
	expect(retired.payloads[0]).toMatchObject({
		nodeId: 1n,
		address: 'node-1:2136',
		location: 'dc1',
		reason: 'stale_active',
	})
})

test('publishes ydb:pool.connection.retired when a pessimized endpoint disappears from discovery', () => {
	using pool = makePool()
	pool.sync([makeProtoEndpoint(3)])
	let [conn] = pool[POOL_GET_ACTIVE_FOR_TESTING]()
	pool.pessimize(conn!)

	using retired = collect('ydb:pool.connection.retired')

	pool.sync([])

	expect(retired.payloads).toHaveLength(1)
	expect(retired.payloads[0]).toMatchObject({
		nodeId: 3n,
		reason: 'stale_pessimized',
	})
})

// ── pessimize / unpessimize ──────────────────────────────────────────────────

test('publishes ydb:pool.connection.pessimized with deadline when pessimize() is called', () => {
	let before = Date.now()
	using pool = makePool({ pessimizationTimeout: 60_000 })
	pool.sync([makeProtoEndpoint(2)])
	let [conn] = pool[POOL_GET_ACTIVE_FOR_TESTING]()

	using pessimized = collect('ydb:pool.connection.pessimized')

	pool.pessimize(conn!)

	expect(pessimized.payloads).toHaveLength(1)
	let p = pessimized.payloads[0] as any
	expect(p).toMatchObject({
		nodeId: 2n,
		address: 'node-2:2136',
		location: 'dc1',
	})
	expect(p.until).toBeGreaterThanOrEqual(before + 60_000)
})

test('publishes ydb:pool.connection.unpessimized after the pessimization timeout elapses', async () => {
	// 1ms timeout + a small wait so `until < Date.now()` holds inside
	// #refreshPessimized when acquire() runs.
	using pool = makePool({ pessimizationTimeout: 1 })
	pool.sync([makeProtoEndpoint(4)])
	let [conn] = pool[POOL_GET_ACTIVE_FOR_TESTING]()
	pool.pessimize(conn!)

	await new Promise((r) => setTimeout(r, 5))

	using unpessimized = collect('ydb:pool.connection.unpessimized')

	pool.acquire() // calls #refreshPessimized() — restores node 4

	expect(unpessimized.payloads).toHaveLength(1)
	expect(unpessimized.payloads[0]).toMatchObject({
		nodeId: 4n,
		address: 'node-4:2136',
		location: 'dc1',
	})
})

// ── removed (physical close) by reason ───────────────────────────────────────

test('publishes ydb:pool.connection.removed with reason=replaced on add() of an existing nodeId', () => {
	using pool = makePool()
	pool.sync([makeProtoEndpoint(5)])

	using removed = collect('ydb:pool.connection.removed')

	pool.add(makeProtoEndpoint(5)) // re-add — old channel must be replaced

	expect(removed.payloads).toHaveLength(1)
	expect(removed.payloads[0]).toMatchObject({
		nodeId: 5n,
		reason: 'replaced',
	})
})

test('publishes ydb:pool.connection.removed with reason=pool_close on close()', () => {
	let pool = makePool()
	pool.sync([makeProtoEndpoint(6), makeProtoEndpoint(7)])

	using removed = collect('ydb:pool.connection.removed')

	pool.close()

	expect(removed.payloads).toHaveLength(2)
	for (let p of removed.payloads) {
		expect(p).toMatchObject({ reason: 'pool_close' })
	}
})

// ── driver lifecycle ────────────────────────────────────────────────────────

/**
 * Stand up a fake DiscoveryService that returns a single endpoint pointing
 * back at the test server. Returned object is `AsyncDisposable` so callers can
 * use `await using`.
 */
async function startDiscoveryServer(opts: { fail?: boolean } = {}) {
	let server = createServer()
	let selfPort = 0

	server.add(
		{
			listEndpoints: DiscoveryServiceDefinition.listEndpoints,
			whoAmI: DiscoveryServiceDefinition.whoAmI,
		},
		{
			async listEndpoints() {
				if (opts.fail) {
					throw new ServerError(Status.INTERNAL, 'discovery boom')
				}
				let result = create(ListEndpointsResultSchema, {
					endpoints: [
						create(EndpointInfoSchema, {
							nodeId: 1,
							address: '127.0.0.1',
							port: selfPort,
							location: 'dc1',
						}),
					],
				})
				return {
					operation: {
						status: StatusIds_StatusCode.SUCCESS,
						ready: true,
						result: anyPack(ListEndpointsResultSchema, result),
					},
				} as any
			},
			async whoAmI() {
				return {} as any
			},
		}
	)

	selfPort = await server.listen('127.0.0.1:0')

	return {
		port: selfPort,
		async [Symbol.asyncDispose]() {
			await server.shutdown()
		},
	}
}

/**
 * Subscribe to a tracing channel and capture start/asyncEnd/error events.
 */
function collectTrace(name: string): {
	start: { ctx: object }[]
	asyncEnd: { ctx: object }[]
	error: { ctx: object & { error: unknown } }[]
} & Disposable {
	let ch = tracingChannel(name)
	let start: { ctx: object }[] = []
	let asyncEnd: { ctx: object }[] = []
	let error: { ctx: object & { error: unknown } }[] = []
	let handlers = {
		start: (ctx: any) => start.push({ ctx: { ...ctx } }),
		asyncEnd: (ctx: any) => asyncEnd.push({ ctx: { ...ctx } }),
		error: (ctx: any) => error.push({ ctx: { ...ctx } }),
	}
	ch.subscribe(handlers as any)
	return {
		start,
		asyncEnd,
		error,
		[Symbol.dispose]() {
			ch.unsubscribe(handlers as any)
		},
	}
}

test('publishes ydb:driver.ready with duration after successful initial discovery', async () => {
	await using server = await startDiscoveryServer()
	using ready = collect('ydb:driver.ready')

	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready()

	expect(ready.payloads).toHaveLength(1)
	let p = ready.payloads[0] as any
	expect(p.database).toBe('/local')
	expect(typeof p.duration).toBe('number')
	expect(p.duration).toBeGreaterThanOrEqual(0)
})

test('publishes ydb:driver.ready synchronously when discovery is disabled', () => {
	using ready = collect('ydb:driver.ready')

	using driver = new Driver('grpc://127.0.0.1:1/local', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.database).toBe('/local')
	expect(ready.payloads).toHaveLength(1)
	expect(ready.payloads[0]).toMatchObject({ database: '/local' })
})

test('publishes ydb:driver.failed with error and duration when initial discovery fails', async () => {
	await using server = await startDiscoveryServer({ fail: true })
	using failed = collect('ydb:driver.failed')

	let driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		// shrink timings so the test does not hang on the default 30s ready timeout
		'ydb.sdk.discovery_timeout_ms': 200,
		'ydb.sdk.discovery_interval_ms': 1_000,
		'ydb.sdk.ready_timeout_ms': 1_000,
	})

	await expect(driver.ready()).rejects.toThrow(/discovery boom|aborted|timed out/i)
	driver.close()

	expect(failed.payloads.length).toBeGreaterThanOrEqual(1)
	let p = failed.payloads[0] as any
	expect(p.database).toBe('/local')
	expect(typeof p.duration).toBe('number')
	expect(p.error).toBeDefined()
})

test('publishes ydb:driver.closed with uptime on close()', async () => {
	await using server = await startDiscoveryServer()

	let driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready()

	using closed = collect('ydb:driver.closed')
	driver.close()

	expect(closed.payloads).toHaveLength(1)
	let p = closed.payloads[0] as any
	expect(p.database).toBe('/local')
	expect(typeof p.uptime).toBe('number')
	expect(p.uptime).toBeGreaterThanOrEqual(0)
})

test('publishes ydb:discovery.completed with added/removed/total counts', async () => {
	await using server = await startDiscoveryServer()
	using completed = collect('ydb:discovery.completed')

	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready()

	expect(completed.payloads.length).toBeGreaterThanOrEqual(1)
	let p = completed.payloads[0] as any
	expect(p).toMatchObject({
		database: '/local',
		addedCount: 1,
		removedCount: 0,
		totalCount: 1,
	})
	expect(typeof p.duration).toBe('number')
})

test('traces tracing:ydb:discovery start and asyncEnd around a successful round', async () => {
	await using server = await startDiscoveryServer()
	using trace = collectTrace('tracing:ydb:discovery')

	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready()

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(trace.error).toHaveLength(0)
	expect(trace.start[0]?.ctx).toMatchObject({ database: '/local' })
})

test('traces tracing:ydb:discovery error when listEndpoints fails', async () => {
	await using server = await startDiscoveryServer({ fail: true })
	using trace = collectTrace('tracing:ydb:discovery')

	let driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 200,
		'ydb.sdk.discovery_interval_ms': 1_000,
		'ydb.sdk.ready_timeout_ms': 1_000,
	})

	await expect(driver.ready()).rejects.toThrow(/discovery boom|aborted|timed out/i)
	driver.close()

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.error.length).toBeGreaterThanOrEqual(1)
	expect(trace.error[0]?.ctx.error).toBeDefined()
})
