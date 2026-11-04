import { expect, inject, test } from 'vitest'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { fromYdb, toJs } from '@ydbjs/value'

type RawColumnsRow = Record<string, WireValue>

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('Variant results require raw mode, including nested and ambiguous values', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	await using sql = query(client)
	let text = `
		$a = Just(Variant(Variant(CAST(NULL AS Int32), "1", Variant<Int32?,Int32?>), "0", Variant<Variant<Int32?,Int32?>,Int32?>));
		$b = Just(Variant(CAST(NULL AS Int32), "1", Variant<Variant<Int32?,Int32?>,Int32?>));
		SELECT AsList(Variant(42, "1", Variant<Int32,Int32>)) AS nested,
			$a AS a, $b AS b,
			CAST(Way(Unwrap($a)) AS Utf8) AS a_branch,
			CAST(Way(Unwrap($b)) AS Utf8) AS b_branch;`

	await expect(
		client.retrySession({ signal: tc.signal }, (session) =>
			session.execute('SELECT AsList(Variant(42, "1", Variant<Int32,Int32>)) AS value;')
		)
	).rejects.toThrow(/Variant.*raw/i)

	let raw = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<RawColumnsRow>(text, {}, { raw: true })
	)
	let set = raw.resultSets[0]!
	let row = set.rows[0]!

	expect(set.columns[0]!.type).toMatchObject({
		type: {
			case: 'listType',
			value: { item: { type: { case: 'variantType' } } },
		},
	})
	expect(row.nested).toMatchObject({
		items: [
			{
				variantIndex: 1,
				value: {
					case: 'nestedValue',
					value: { value: { case: 'int32Value', value: 42 } },
				},
			},
		],
	})
	expect(set.columns[1]!.type).toEqual(set.columns[2]!.type)
	expect(row.a).toEqual(row.b)
	expect(toJs(fromYdb(row.a_branch!, set.columns[3]!.type!))).toBe('0')
	expect(toJs(fromYdb(row.b_branch!, set.columns[4]!.type!))).toBe('1')

	let rows = await sql<[RawColumnsRow]>`${sql.unsafe(text)}`.raw().signal(tc.signal)

	expect(rows[0]![0]).toEqual(row)
})
