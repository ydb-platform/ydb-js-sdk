import { expect, inject, test } from 'vitest'

import { Driver } from '../dist/esm/driver.js'

test('initializes driver ready', async () => {
	let driver = new Driver(inject('connectionString'), {
		'ydb.sdk.discovery_timeout_ms': 1000,
	})

	expect(() => driver.ready(), 'Driver is not ready').not.throw()
})
