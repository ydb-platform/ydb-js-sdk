import * as assert from 'node:assert'
import test from 'node:test'
import { inspect } from 'node:util'

import { StatsMode } from '@ydbjs/api/query'
import { Driver } from '@ydbjs/core'

import { query } from '../dist/esm/index.js'

await test('Query', async (tc) => {
	await tc.test('simple', async () => {
		let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
		await driver.ready(tc.signal)

		let sql = query(driver)

		let stmt = sql`SELECT ${[{ name: 'Vlad', age: 26n }, { name: 'Anonymous' }]};`
			.signal(tc.signal)
			.withStats(StatsMode.BASIC)

		console.log(`========================== TEXT ==========================`)
		console.log(stmt.text)
		console.log(`========================== TEXT ==========================`)
		console.log()

		console.log('==========================PARAMS==========================')
		console.log(inspect(stmt.parameters, { depth: 10 }))
		console.log('==========================PARAMS==========================')
		console.log()

		await assert.doesNotReject(async () => await stmt)

		console.log('==========================RESULT==========================')
		console.log(inspect(await stmt, { depth: 10 }))
		console.log('==========================RESULT==========================')

		console.log('==========================STATS===========================')
		console.log(inspect(stmt.stats(), { depth: 10 }))
		console.log('==========================STATS===========================')
	})
})
