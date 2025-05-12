import { expect, test } from 'vitest'

import { Driver } from '../dist/esm/driver.js'

test('database in pathname', async () => {
	let driver = new Driver('grpc://localhost:1234/path', {
		'ydb.sdk.discovery_timeout_ms': 1000,
	})

	expect(driver.database, 'Database is not set').toBe('/path')
})

test('database in querystring', async () => {
	let driver = new Driver('grpc://localhost:1234?database=/query', {
		'ydb.sdk.discovery_timeout_ms': 1000,
	})

	expect(driver.database, 'Database is not set').toBe('/query')
})
