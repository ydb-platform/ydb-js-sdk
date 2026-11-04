// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { expect, test } from 'vitest'
import { Int32, Text } from '@ydbjs/value/primitive'
import { Optional } from '@ydbjs/value/optional'
import { Tagged } from '@ydbjs/value/tagged'
import { List, ListType } from '@ydbjs/value/list'
import { Tuple } from '@ydbjs/value/tuple'
import { Dict } from '@ydbjs/value/dict'
import { Struct } from '@ydbjs/value/struct'
import { QueryClient } from './client.js'
import { query } from './index.js'
import { startClientServer } from './client.fixtures.js'

test('rejects server-unsupported Tagged parameters before ExecuteQuery', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	await using sql = query(client)
	let tagged = new Tagged(new Int32(1), 'id')
	let values = [
		tagged,
		new Optional(null, tagged.type),
		new List([], new ListType(tagged.type)),
		new Tuple(tagged),
		new Struct({ value: tagged }),
		new Dict([new Text('key'), tagged]),
		new Dict([tagged, new Int32(1)]),
	]

	for (let value of values) {
		await expect(
			client.retrySession({ signal: tc.signal }, (session) =>
				session.execute('SELECT $value', { value })
			)
		).rejects.toThrow(/Tagged query parameters/)
		await expect(Promise.resolve(sql`SELECT ${value}`.signal(tc.signal))).rejects.toThrow(
			/Tagged query parameters/
		)
	}
	expect(server.executions).toHaveLength(0)
})
