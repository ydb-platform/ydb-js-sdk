import { expect, test } from 'vitest'

import { Driver } from '../dist/esm/driver.js'

test('database in pathname', async () => {
	let driver = new Driver('grpc://localhost:1234/path', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.database, 'Database is not set').toBe('/path')
})

test('database in querystring', async () => {
	let driver = new Driver('grpc://localhost:1234?database=/query', {
		'ydb.sdk.enable_discovery': false,
	})

	expect(driver.database, 'Database is not set').toBe('/query')
})
