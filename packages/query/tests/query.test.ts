import test from 'node:test';
import { inspect } from 'node:util';
import * as assert from 'node:assert';

import { Driver } from '@ydbjs/core';

import { query } from '../dist/esm/index.js';

test('Query', async (tc) => {
	await tc.test('simple', async () => {
		let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
		await driver.ready(tc.signal)

		let sql = query(driver)

		let stmt = sql`SELECT ${[{ "name": "Vlad", "age": 26n }, { "name": "Anonymous" }]};`
			.timeout(5)

		stmt.execute()

		console.log(`========================== TEXT ==========================`)
		console.log(stmt.text)
		console.log(`========================== TEXT ==========================`)
		console.log()

		console.log('==========================PARAMS==========================',)
		console.log(inspect(stmt.parameters, { depth: 10 }))
		console.log('==========================PARAMS==========================',)
		console.log()

		await assert.doesNotReject(async () => await stmt)

		console.log('==========================RESULT==========================',)
		console.log(inspect(await stmt, { depth: 10 }))
		console.log('==========================RESULT==========================',)
	})
})
