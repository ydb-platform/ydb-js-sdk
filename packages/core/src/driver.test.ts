import { expect, test } from 'vitest'

import { Driver } from './driver.ts'

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

	expect(driver.options.channelOptions?.['grpc.keepalive_time_ms']).toBe(
		30_000
	)
	expect(driver.options.channelOptions?.['grpc.keepalive_timeout_ms']).toBe(
		5_000
	)
	expect(
		driver.options.channelOptions?.['grpc.keepalive_permit_without_calls']
	).toBe(1)

	expect(
		driver.options.channelOptions?.['grpc.max_send_message_length']
	).toBe(64 * 1024 * 1024)
	expect(
		driver.options.channelOptions?.['grpc.max_receive_message_length']
	).toBe(64 * 1024 * 1024)

	expect(
		driver.options.channelOptions?.['grpc.max_connection_age_ms']
	).toBeUndefined()

	expect(
		driver.options.channelOptions?.['grpc.initial_reconnect_backoff_ms']
	).toBe(50)
	expect(
		driver.options.channelOptions?.['grpc.max_reconnect_backoff_ms']
	).toBe(5_000)

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

	expect(driver.options.channelOptions?.['grpc.keepalive_time_ms']).toBe(
		60_000
	)
	expect(
		driver.options.channelOptions?.['grpc.max_send_message_length']
	).toBe(32 * 1024 * 1024)

	expect(driver.options.channelOptions?.['grpc.keepalive_timeout_ms']).toBe(
		5_000
	)

	driver.close()
})

test('creating thousands of drivers with using does not leak memory', async () => {
	let iterations = 100000
	let memoryBefore = process.memoryUsage().heapUsed

	for (let i = 0; i < iterations; i++) {
		using _driver = new Driver('grpc://localhost:2136/local', {
			'ydb.sdk.enable_discovery': false,
		})

		if (i % 1000 === 0 && i > 0) {
			if (global.gc) {
				global.gc()
			}
		}
	}

	if (global.gc) {
		global.gc()
	}

	let memoryAfter = process.memoryUsage().heapUsed
	let memoryGrowth = memoryAfter - memoryBefore
	let memoryGrowthMB = memoryGrowth / (1024 * 1024)

	expect(memoryGrowthMB).toBeLessThan(50)
})
