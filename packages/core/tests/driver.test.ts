import test from 'node:test';
import * as assert from 'node:assert';

import { Driver } from '../dist/esm/driver.js';

test('Driver', async (tc) => {
	await tc.test('simple', async () => {
		let driver = new Driver(process.env['YDB_CONNECTION_STRING']!, {
			'ydb.sdk.discovery_timeout_ms': 1000,
		})

		await assert.doesNotReject(driver.ready(tc.signal), 'Driver is not ready');
	})
})
