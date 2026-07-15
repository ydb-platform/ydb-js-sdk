import { expect, test } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import {
	DiscoveryServiceDefinition,
	EndpointInfoSchema,
	ListEndpointsResultSchema,
} from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { ServerError, Status, createServer } from 'nice-grpc'

import { Driver, kRegisterLibrary } from './driver.ts'
import {
	DriverCSDatabaseError,
	DriverDegradedThresholdError,
	DriverResponseError,
} from './errors.ts'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import pkg from '../package.json' with { type: 'json' }

// Stand up a discovery server whose listEndpoints returns a caller-supplied
// operation object (to exercise the #fetchEndpoints error paths).
async function startBadDiscovery(operation: unknown) {
	let server = createServer()
	server.add(
		{
			listEndpoints: DiscoveryServiceDefinition.listEndpoints,
			whoAmI: DiscoveryServiceDefinition.whoAmI,
		},
		{
			async listEndpoints() {
				return { operation } as any
			},
			async whoAmI() {
				return {} as any
			},
		}
	)
	let port = await server.listen('127.0.0.1:0')
	return { port, [Symbol.asyncDispose]: () => server.shutdown() }
}

test('parses database from the pathname', () => {
	using driver = new Driver('grpc://ydb:2136/local', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.database).toBe('/local')
})

test('parses database from the querystring', () => {
	using driver = new Driver('grpc://ydb:2136/?database=/local', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.database).toBe('/local')
})

test('rejects a discovery_degraded_threshold outside (0, 1]', () => {
	expect(
		() =>
			new Driver('grpc://ydb:2136/local', {
				'ydb.sdk.enable_discovery': false,
				'ydb.sdk.discovery_degraded_threshold': 50,
			})
	).toThrow(DriverDegradedThresholdError)

	expect(
		() =>
			new Driver('grpc://ydb:2136/local', {
				'ydb.sdk.enable_discovery': false,
				'ydb.sdk.discovery_degraded_threshold': 0,
			})
	).toThrow(DriverDegradedThresholdError)
})

test('accepts a discovery_degraded_threshold within (0, 1]', () => {
	using driver = new Driver('grpc://ydb:2136/local', {
		'ydb.sdk.enable_discovery': false,
		'ydb.sdk.discovery_degraded_threshold': 0.75,
	})
	expect(driver.options['ydb.sdk.discovery_degraded_threshold']).toBe(0.75)
})

test('rejects a connection string without a database', () => {
	expect(() => new Driver('grpc://ydb:2136/', { 'ydb.sdk.enable_discovery': false })).toThrow(
		DriverCSDatabaseError
	)
})

test('builds TLS credentials from secureOptions and marks itself secure', () => {
	using driver = new Driver('grpcs://ydb:2135/local', {
		'ydb.sdk.enable_discovery': false,
		secureOptions: {},
	})
	expect(driver.isSecure).toBe(true)
})

test('uses a provided credentials provider', async () => {
	using driver = new Driver('grpc://ydb:2136/local', {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	expect(await driver.token).toBe('')
})

test('discovery fails when the operation status is not SUCCESS', async (tc) => {
	await using server = await startBadDiscovery({
		status: StatusIds_StatusCode.BAD_REQUEST,
		ready: true,
	})
	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 200,
		'ydb.sdk.discovery_interval_ms': 1_000,
		'ydb.sdk.ready_timeout_ms': 1_000,
	})
	let error = await driver.ready(tc.signal).then(
		() => undefined,
		(e) => e
	)
	expect(error).toBeInstanceOf(Error)
})

test('discovery fails when the response has no operation', async (tc) => {
	await using server = await startBadDiscovery(undefined)
	using driver = new Driver(`grpc://127.0.0.1:${server.port}/local`, {
		'ydb.sdk.discovery_timeout_ms': 200,
		'ydb.sdk.discovery_interval_ms': 1_000,
		'ydb.sdk.ready_timeout_ms': 1_000,
	})
	await expect(driver.ready(tc.signal)).rejects.toThrow(DriverResponseError)
})

test('validates default channel options for long-lived streams', () => {
	let driver = new Driver('grpc://ydb:2136/local', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.options.channelOptions?.['grpc.keepalive_time_ms']).toBe(10_000)
	expect(driver.options.channelOptions?.['grpc.keepalive_timeout_ms']).toBe(5_000)
	expect(driver.options.channelOptions?.['grpc.keepalive_permit_without_calls']).toBe(1)

	expect(driver.options.channelOptions?.['grpc.max_send_message_length']).toBe(64 * 1024 * 1024)
	expect(driver.options.channelOptions?.['grpc.max_receive_message_length']).toBe(
		64 * 1024 * 1024
	)

	expect(driver.options.channelOptions?.['grpc.max_connection_age_ms']).toBeUndefined()

	expect(driver.options.channelOptions?.['grpc.initial_reconnect_backoff_ms']).toBe(50)
	expect(driver.options.channelOptions?.['grpc.max_reconnect_backoff_ms']).toBe(5_000)

	driver.close()
})

test('allows custom channel options override', () => {
	let customOptions = {
		'ydb.sdk.enable_discovery': false,
		channelOptions: {
			'grpc.keepalive_time_ms': 60_000, // Custom value
			'grpc.max_send_message_length': 32 * 1024 * 1024, // Custom value
		},
	}

	let driver = new Driver('grpc://localhost:2136/test', customOptions)

	expect(driver.options.channelOptions?.['grpc.keepalive_time_ms']).toBe(60_000)
	expect(driver.options.channelOptions?.['grpc.max_send_message_length']).toBe(32 * 1024 * 1024)

	expect(driver.options.channelOptions?.['grpc.keepalive_timeout_ms']).toBe(5_000)

	driver.close()
})

test('adds x-ydb-sdk-build-info header with current sdk version', async () => {
	let server = createServer()
	let receivedBuildInfo: string | undefined
	let discoveryService = {
		listEndpoints: DiscoveryServiceDefinition.listEndpoints,
		whoAmI: DiscoveryServiceDefinition.whoAmI,
	}

	server.add(discoveryService, {
		async listEndpoints(_, context) {
			receivedBuildInfo = context.metadata.get('x-ydb-sdk-build-info')
			return {}
		},
		async whoAmI() {
			return {}
		},
	})

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	try {
		let client = driver.createClient(discoveryService)
		await client.listEndpoints({ database: driver.database })

		expect(receivedBuildInfo).toBe(`ydb-js-sdk/${pkg.version}`)
	} finally {
		driver.close()
		await server.shutdown()
	}
})

test('appends registered libraries to x-ydb-sdk-build-info after the native sdk token', async () => {
	let server = createServer()
	let received: string[] = []
	let discoveryService = {
		listEndpoints: DiscoveryServiceDefinition.listEndpoints,
		whoAmI: DiscoveryServiceDefinition.whoAmI,
	}

	server.add(discoveryService, {
		async listEndpoints(_, context) {
			received.push(context.metadata.get('x-ydb-sdk-build-info') ?? '')
			return {}
		},
		async whoAmI() {
			return {}
		},
	})

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	try {
		let client = driver.createClient(discoveryService)

		driver[kRegisterLibrary]('@ydbjs/drizzle-adapter', '1.2.3')
		await client.listEndpoints({ database: driver.database })

		driver[kRegisterLibrary]('@ydbjs/drizzle-adapter', '1.2.3')
		driver[kRegisterLibrary]('@ydbjs/other', '0.1.0')
		await client.listEndpoints({ database: driver.database })

		expect(received[0]).toBe(`ydb-js-sdk/${pkg.version};@ydbjs/drizzle-adapter/1.2.3`)
		expect(received[1]).toBe(
			`ydb-js-sdk/${pkg.version};@ydbjs/drizzle-adapter/1.2.3;@ydbjs/other/0.1.0`
		)
	} finally {
		driver.close()
		await server.shutdown()
	}
})

test('createClient with a direct-IO target hard-routes and disposes cleanly', async (tc) => {
	// A discovery server that reports itself as node 1; the direct client then
	// hard-routes there and its whoAmI succeeds.
	let server = createServer()
	let port = 0
	let discoveryService = {
		listEndpoints: DiscoveryServiceDefinition.listEndpoints,
		whoAmI: DiscoveryServiceDefinition.whoAmI,
	}
	server.add(discoveryService, {
		async listEndpoints() {
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
	})
	port = await server.listen('127.0.0.1:0')

	try {
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.discovery_timeout_ms': 5_000,
		})
		await driver.ready(tc.signal)

		{
			using client = driver.createClient(discoveryService, {
				nodeId: 1n,
				endpoint: { host: '127.0.0.1', port, generation: 3 },
				hard: true,
			})
			// The client is Disposable and hard-routes to the pinned node.
			expect(typeof (client as unknown as Disposable)[Symbol.dispose]).toBe('function')
			await client.whoAmI({}, { signal: tc.signal })
		}
		// After dispose the pin is released — a fresh soft client still works.
		let soft = driver.createClient(discoveryService)
		await soft.whoAmI({}, { signal: tc.signal })
	} finally {
		await server.shutdown()
	}
})

test('survives background rediscovery failure and keeps serving requests', async (tc) => {
	let unhandled: unknown[] = []
	let trap = (reason: unknown) => unhandled.push(reason)
	process.on('unhandledRejection', trap)

	let server = createServer()
	let port = 0
	let calls = 0
	let discoveryService = {
		listEndpoints: DiscoveryServiceDefinition.listEndpoints,
		whoAmI: DiscoveryServiceDefinition.whoAmI,
	}

	server.add(discoveryService, {
		// First round succeeds so the driver becomes ready; every later round
		// fails like a node dropping mid-rediscovery.
		async listEndpoints() {
			calls += 1
			if (calls > 1) {
				throw new ServerError(Status.UNAVAILABLE, 'Connection dropped')
			}
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
	})

	port = await server.listen('127.0.0.1:0')

	try {
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.discovery_timeout_ms': 100,
			'ydb.sdk.discovery_interval_ms': 150,
		})
		await driver.ready(tc.signal)

		// Let several rediscovery ticks fail; without a rejection handler each
		// one would surface as an unhandledRejection and kill the process.
		await new Promise((resolve) => setTimeout(resolve, 500))
		expect(calls).toBeGreaterThan(1)

		// The pool still serves the endpoint from the last successful round.
		let client = driver.createClient(discoveryService)
		await client.whoAmI({}, { signal: tc.signal })

		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', trap)
		await server.shutdown()
	}
})
