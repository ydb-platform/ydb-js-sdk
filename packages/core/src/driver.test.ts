import { expect, test } from 'vitest'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { createServer } from 'nice-grpc'

import { Driver } from './driver.ts'
import pkg from '../package.json' with { type: 'json' }

test('database in pathname', async () => {
	let driver = new Driver('grpc://ydb:2136/local', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.database).toBe('/local')
})

test('database in querystring', async () => {
	let driver = new Driver('grpc://ydb:2136/?database=/local', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.database).toBe('/local')
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
	let receivedBuildInfo = ''
	let serviceDefinition = {
		listEndpoints: DiscoveryServiceDefinition.listEndpoints,
	}

	server.add(serviceDefinition, {
		async listEndpoints(_, context) {
			receivedBuildInfo = context.metadata.get('x-ydb-sdk-build-info') ?? ''
			return {}
		},
	})

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	try {
		let client = driver.createClient(serviceDefinition)
		await client.listEndpoints({ database: driver.database })

		expect(receivedBuildInfo).toBe(`ydb-js-sdk/${pkg.version}`)
	} finally {
		driver.close()
		await server.shutdown()
	}
})
