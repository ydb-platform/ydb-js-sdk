import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { QueryClient } from '@ydbjs/query'
import { toJs } from '@ydbjs/value'
import { Tagged } from '@ydbjs/value/tagged'

type TaggedRow = { value: Tagged }

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('Tagged query results retain their tag and typed payload', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)

	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<[TaggedRow]>('SELECT AsTagged(42, "customer/id") AS value;')
	)
	let value = result.resultSets[0]!.rows[0]!.value

	expect(value).toBeInstanceOf(Tagged)
	expect(value.type.tag).toBe('customer/id')
	expect(toJs(value.item)).toBe(42)
})
