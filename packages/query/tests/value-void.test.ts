import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { Void } from '@ydbjs/value/void'

type VoidRow = { value: Void }

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('Void query results retain their typed value', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)

	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<[VoidRow]>('SELECT Void() AS value;')
	)

	expect(result.resultSets[0]!.rows[0]!.value).toBeInstanceOf(Void)
})

test('Void values work as query parameters', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)

	let rows = await sql<[VoidRow]>`SELECT ${new Void()} AS value`.signal(tc.signal)

	expect(rows[0]![0]!.value).toBeInstanceOf(Void)
})
