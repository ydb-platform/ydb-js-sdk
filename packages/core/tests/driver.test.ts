import { expect, inject, test } from 'vitest'

import { Driver } from '../src/driver.js'

test('initializes driver ready', async () => {
	let driver = new Driver(inject('connectionString'), {
		'ydb.sdk.discovery_timeout_ms': 1000,
	})

	expect(() => driver.ready()).not.throw()
})
