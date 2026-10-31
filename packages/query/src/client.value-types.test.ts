// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { expect, test } from 'vitest'
import { Int32, Int32Type, Text } from '@ydbjs/value/primitive'
import { Optional, OptionalType } from '@ydbjs/value/optional'
import { Tagged, TaggedType } from '@ydbjs/value/tagged'
import { Variant, VariantType } from '@ydbjs/value/variant'
import { List, ListType } from '@ydbjs/value/list'
import { Tuple, TupleType } from '@ydbjs/value/tuple'
import { Dict } from '@ydbjs/value/dict'
import { Struct } from '@ydbjs/value/struct'
import { QueryClient } from './client.js'
import { query } from './index.js'
import { startClientServer } from './client.fixtures.js'

for (let [name, makeValues, message] of [
	[
		'Tagged',
		() => [
			new Tagged(new Int32(1), 'id'),
			new List([], new ListType(new TaggedType('id', new Int32Type()))),
		],
		/Tagged query parameters/,
	],
	[
		'absent Optional Variant',
		() => {
			let variant = new VariantType(new TupleType([new Int32Type()]))
			let absent = new Optional(null, variant)
			return [
				absent,
				new Optional(null, new OptionalType(variant)),
				new Optional(absent),
				new List(absent),
				new Tuple(absent),
				new Dict([new Text('x'), absent]),
				new Struct({ x: absent }),
				new Variant(absent, 0, new VariantType(new TupleType([absent.type]))),
			]
		},
		/absent Optional<Variant>/,
	],
] as const) {
	test(`rejects server-unsupported ${name} parameters before ExecuteQuery`, async (tc) => {
		using server = await startClientServer()
		await using client = new QueryClient(server.driver)
		await using sql = query(client)
		for (let value of makeValues()) {
			await expect(
				client.retrySession({ signal: tc.signal }, (session) =>
					session.execute('SELECT $value', { value })
				)
			).rejects.toThrow(message)
			await expect(Promise.resolve(sql`SELECT ${value}`.signal(tc.signal))).rejects.toThrow(
				message
			)
		}
		expect(server.executions).toHaveLength(0)
	})
}
