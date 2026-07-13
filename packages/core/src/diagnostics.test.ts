import { channel as dc, tracingChannel } from 'node:diagnostics_channel'
import { setTimeout as sleep } from 'node:timers/promises'

import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import {
	DiscoveryServiceDefinition,
	EndpointInfoSchema,
	ListEndpointsResultSchema,
} from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { ServerError, Status, createServer } from 'nice-grpc'
import { expect, test } from 'vitest'

import { Driver } from './driver.js'

// The connection-pool diagnostics (ydb:driver.connection.added/retired/removed/
// pessimized/unpessimized) are covered against the endpoints engine in
// packages/core/src/endpoints/*. This file covers the Driver-lifecycle channels
// end-to-end against a fake DiscoveryService.

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

/**
 * Stand up a fake DiscoveryService that returns a single endpoint pointing back
 * at the test server. `fail: true` rejects with a NON-retryable status so the
 * driver's discovery goes terminal (`ydb:driver.failed`); a retryable failure
 * would instead keep retrying until the ready timeout.
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
					throw new ServerError(Status.PERMISSION_DENIED, 'discovery boom')
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

test('publishes ydb:driver.ready with duration after successful initial discovery', async (tc) => {
	await using server = await startDiscoveryServer()
	using ready = collect('ydb:driver.ready')

	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready(tc.signal)

	expect(ready.payloads).toHaveLength(1)
	let p = ready.payloads[0] as any
	expect(p.driver.database).toBe('/local')
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
	expect(ready.payloads[0]).toMatchObject({ driver: { database: '/local' } })
})

test('publishes ydb:driver.failed with error and duration when initial discovery fails non-retryably', async () => {
	await using server = await startDiscoveryServer({ fail: true })
	using failed = collect('ydb:driver.failed')

	let driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 200,
		'ydb.sdk.discovery_interval_ms': 1_000,
		'ydb.sdk.ready_timeout_ms': 1_000,
	})

	await expect(driver.ready()).rejects.toThrow(/discovery boom|permission|aborted|timed out/i)
	driver.close()

	expect(failed.payloads.length).toBeGreaterThanOrEqual(1)
	let p = failed.payloads[0] as any
	expect(p.driver.database).toBe('/local')
	expect(typeof p.duration).toBe('number')
	expect(p.error).toBeDefined()
})

test('publishes ydb:driver.closed with uptime on close()', async (tc) => {
	await using server = await startDiscoveryServer()

	let driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready(tc.signal)

	using closed = collect('ydb:driver.closed')
	driver.close()
	// The endpoints pool tears down and publishes `closed` on a later turn.
	await sleep(50)

	expect(closed.payloads).toHaveLength(1)
	let p = closed.payloads[0] as any
	expect(p.driver.database).toBe('/local')
	expect(typeof p.uptime).toBe('number')
	expect(p.uptime).toBeGreaterThanOrEqual(0)
})

test('await using driver publishes ydb:driver.closed once via asyncDispose', async (tc) => {
	await using server = await startDiscoveryServer()
	using closed = collect('ydb:driver.closed')

	{
		await using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
			'ydb.sdk.discovery_timeout_ms': 5_000,
		})
		await driver.ready(tc.signal)
	}
	// asyncDispose drains and awaits the graceful close; closed is already published.
	expect(closed.payloads).toHaveLength(1)
	let p = closed.payloads[0] as any
	expect(p.driver.database).toBe('/local')
	expect(typeof p.uptime).toBe('number')
})

test('publishes ydb:driver.discovery.completed with added/removed/total counts', async (tc) => {
	await using server = await startDiscoveryServer()
	using completed = collect('ydb:driver.discovery.completed')

	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready(tc.signal)

	expect(completed.payloads.length).toBeGreaterThanOrEqual(1)
	let p = completed.payloads[0] as any
	expect(p).toMatchObject({
		driver: { database: '/local' },
		addedCount: 1,
		removedCount: 0,
		totalCount: 1,
	})
	expect(typeof p.duration).toBe('number')
})

test('traces tracing:ydb:driver.discovery start and asyncEnd around a successful round', async (tc) => {
	await using server = await startDiscoveryServer()
	using trace = collectTrace('tracing:ydb:driver.discovery')

	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await driver.ready(tc.signal)

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(trace.error).toHaveLength(0)
	expect(trace.start[0]?.ctx).toMatchObject({ driver: { database: '/local' } })
})

test('close() during in-flight initial discovery suppresses ydb:driver.ready / .failed', async () => {
	// Discovery server that hangs until released — close() must terminate the
	// engine before the round can resolve. A deterministic entry latch (not a
	// sleep) guarantees the RPC has actually landed before we close.
	let entered = Promise.withResolvers<void>()
	let release = Promise.withResolvers<void>()
	let server = createServer()
	let port = 0
	server.add(
		{
			listEndpoints: DiscoveryServiceDefinition.listEndpoints,
			whoAmI: DiscoveryServiceDefinition.whoAmI,
		},
		{
			async listEndpoints() {
				entered.resolve()
				await release.promise
				let result = create(ListEndpointsResultSchema, {
					endpoints: [
						create(EndpointInfoSchema, {
							nodeId: 1,
							address: '127.0.0.1',
							port,
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
	port = await server.listen('127.0.0.1:0')

	using ready = collect('ydb:driver.ready')
	using failed = collect('ydb:driver.failed')
	using closed = collect('ydb:driver.closed')

	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 5_000,
		'ydb.sdk.ready_timeout_ms': 5_000,
	})

	await entered.promise // the RPC has landed on the server
	driver.close()

	// Let the handler resolve so a (now-cancelled) round has a chance to fire.
	release.resolve()
	await sleep(50)

	expect(closed.payloads).toHaveLength(1)
	expect(ready.payloads).toHaveLength(0)
	expect(failed.payloads).toHaveLength(0)

	await server.shutdown()
})

test('traces tracing:ydb:driver.discovery error when listEndpoints fails', async () => {
	await using server = await startDiscoveryServer({ fail: true })
	using trace = collectTrace('tracing:ydb:driver.discovery')

	let driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 200,
		'ydb.sdk.discovery_interval_ms': 1_000,
		'ydb.sdk.ready_timeout_ms': 1_000,
	})

	await expect(driver.ready()).rejects.toThrow(/discovery boom|permission|aborted|timed out/i)
	driver.close()

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.error.length).toBeGreaterThanOrEqual(1)
	expect(trace.error[0]?.ctx.error).toBeDefined()
})
