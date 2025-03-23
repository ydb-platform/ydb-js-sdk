import test from 'node:test';
import * as assert from 'node:assert';

import { StaticCredentialsProvider } from '@ydbjs/auth/static';
import { Driver } from '../dist/esm/driver.js';

test('Driver', async (tc) => {
	await tc.test('simple', async () => {
		let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)

		assert.ok(await driver.ready(tc.signal))
	})

	await tc.test('with static credentials', async () => {
		let credentialsProvier = new StaticCredentialsProvider({ username: 'root', password: '1234' }, process.env['YDB_CONNECTION_STRING']!);

		let driver = new Driver(process.env['YDB_CONNECTION_STRING']!, {
			credentialsProvier: credentialsProvier,
		})

		assert.ok(await driver.ready(tc.signal))
	})

	await tc.test('without discovery', async () => {
		let credentialsProvier = new StaticCredentialsProvider({ username: 'root', password: '1234' }, process.env['YDB_CONNECTION_STRING']!);

		let driver = new Driver(process.env['YDB_CONNECTION_STRING']!, {
			credentialsProvier: credentialsProvier,
			'ydb.sdk.enable_discovery': false,
		})

		assert.ok(await driver.ready(tc.signal))
	})
})
