import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

import { escJsonPathKey } from '../src/encoding.ts'

type PathRow = { path: string }

test('JSONPath keys remain one SQL string literal', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let key = "field\\' AS Utf8); SELECT 999 AS injected; --"
	let literal = sql.unsafe("'$." + escJsonPathKey(key) + "'")

	let result = await sql<[PathRow]>`SELECT CAST(${literal} AS Utf8) AS path;`.signal(tc.signal)

	expect(result).toHaveLength(1)
	expect(result[0]).toEqual([{ path: '$.' + key }])
})
