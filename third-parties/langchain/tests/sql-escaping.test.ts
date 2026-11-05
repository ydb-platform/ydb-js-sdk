import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { QueryClient } from '@ydbjs/query'

import { escJsonPathKey } from '../src/encoding.ts'

type PathRow = { path: string }

test('JSONPath keys remain one SQL string literal', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using client = new QueryClient(driver)
	let key = "field\\' AS Utf8); SELECT 999 AS injected; --"
	let literal = "'$." + escJsonPathKey(key) + "'"

	let { resultSets } = await client.retrySession({ signal: tc.signal }, (session) => {
		return session.execute<[PathRow]>(`SELECT CAST(${literal} AS Utf8) AS path;`)
	})

	expect(resultSets).toHaveLength(1)
	expect(resultSets[0].rows).toEqual([{ path: '$.' + key }])
})
