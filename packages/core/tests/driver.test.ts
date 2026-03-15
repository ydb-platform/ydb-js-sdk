import { expect, inject, test } from 'vitest'

import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { ListEndpointsResultSchema } from '@ydbjs/api/discovery'

import { Driver } from '../src/driver.js'
import type { DiscoveryEvent } from '../src/hooks.js'

test('awaits ready() successfully with discovery enabled', async () => {
	using driver = new Driver(inject('connectionString'), {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})

	await expect(driver.ready()).resolves.toBeUndefined()
})

test('onDiscovery hook fires with endpoint data after ready', async () => {
	let discoveryEvents: DiscoveryEvent[] = []

	using driver = new Driver(inject('connectionString'), {
		'ydb.sdk.discovery_timeout_ms': 5_000,
		hooks: {
			onDiscovery(event) {
				discoveryEvents.push(event)
			},
		},
	})

	await driver.ready()

	// At least one discovery round must have completed by the time ready() resolves
	expect(discoveryEvents.length).toBeGreaterThan(0)

	let event = discoveryEvents[0]!

	// The discovery response must contain at least one endpoint
	expect(event.endpoints.length).toBeGreaterThan(0)

	// Every endpoint must have a nodeId, address, and location
	for (let ep of event.endpoints) {
		expect(typeof ep.nodeId).toBe('bigint')
		expect(ep.address).toMatch(/^.+:\d+$/)
		expect(typeof ep.location).toBe('string')
	}

	// On initial discovery all endpoints are "added", none removed
	expect(event.added.length).toBeGreaterThan(0)
	expect(event.removed.length).toBe(0)
})

test('BalancedChannel routes real RPC through connection pool', async () => {
	using driver = new Driver(inject('connectionString'), {
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})

	await driver.ready()

	// createClient() returns a nice-grpc client backed by BalancedChannel when
	// discovery is enabled. Making a real RPC verifies the full path:
	// BalancedChannel.createCall() → pool.acquire() → real grpc-js channel.
	let client = driver.createClient(DiscoveryServiceDefinition)

	let response = await client.listEndpoints({ database: driver.database })

	expect(response.operation).toBeDefined()
	expect(response.operation!.status).toBe(StatusIds_StatusCode.SUCCESS)

	let result = anyUnpack(response.operation!.result!, ListEndpointsResultSchema)
	expect(result).toBeDefined()
	expect(result!.endpoints.length).toBeGreaterThan(0)
})

test('onCall hook fires for each RPC dispatched through BalancedChannel', async () => {
	let callEvents: { method: string; nodeId: bigint; preferred: boolean }[] = []

	using driver = new Driver(inject('connectionString'), {
		'ydb.sdk.discovery_timeout_ms': 5_000,
		hooks: {
			onCall(event) {
				callEvents.push({
					method: event.method,
					nodeId: event.endpoint.nodeId,
					preferred: event.preferred,
				})
			},
		},
	})

	await driver.ready()

	let callsBefore = callEvents.length

	let client = driver.createClient(DiscoveryServiceDefinition)
	await client.listEndpoints({ database: driver.database })

	// At least one onCall event must have fired for the listEndpoints RPC
	expect(callEvents.length).toBeGreaterThan(callsBefore)

	let rpcEvent = callEvents.find((e) => e.method.includes('ListEndpoints'))
	expect(rpcEvent).toBeDefined()
	expect(typeof rpcEvent!.nodeId).toBe('bigint')
})

test('onCall completion callback fires with status and duration', async () => {
	let completions: { grpcStatusCode: number; duration: number }[] = []

	using driver = new Driver(inject('connectionString'), {
		'ydb.sdk.discovery_timeout_ms': 5_000,
		hooks: {
			onCall() {
				return (complete) => {
					completions.push({
						grpcStatusCode: complete.grpcStatusCode,
						duration: complete.duration,
					})
				}
			},
		},
	})

	await driver.ready()

	let completionsBefore = completions.length

	let client = driver.createClient(DiscoveryServiceDefinition)
	await client.listEndpoints({ database: driver.database })

	// Completion callback must have fired for the RPC
	expect(completions.length).toBeGreaterThan(completionsBefore)

	let completion = completions[completions.length - 1]!

	// Successful RPC: gRPC status 0 = OK
	expect(completion.grpcStatusCode).toBe(0)

	// Duration must be a positive number
	expect(completion.duration).toBeGreaterThan(0)
})

test('creating thousands of drivers with using does not leak memory', async () => {
	// This test is intended to catch unbounded leaks (e.g. forgetting to close channels),
	// not to measure exact heap usage. Heap measurements are noisy unless we can trigger
	// GC explicitly, so we only run the assertion when global.gc is available.
	if (typeof global.gc !== 'function') {
		// Node was not started with --expose-gc; skip heap-growth assertion in this environment.
		return
	}

	// We use fewer iterations and a proportional threshold to keep this test fast and stable.
	let iterations = 2_000
	let memoryBefore = process.memoryUsage().heapUsed

	for (let i = 0; i < iterations; i++) {
		using _driver = new Driver('grpc://localhost:2136/local', {
			'ydb.sdk.enable_discovery': false,
		})

		if (i % 500 === 0 && i > 0) {
			global.gc()
		}
	}

	global.gc()

	let memoryAfter = process.memoryUsage().heapUsed
	let memoryGrowth = memoryAfter - memoryBefore
	let memoryGrowthMB = memoryGrowth / (1024 * 1024)

	expect(memoryGrowthMB).toBeLessThan(10)
})
