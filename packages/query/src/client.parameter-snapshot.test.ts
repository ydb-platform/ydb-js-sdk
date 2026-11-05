import { runInNewContext } from 'node:vm'
import { WireType } from '@bufbuild/protobuf/wire'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { Bytes, Int32 } from '@ydbjs/value/primitive'
import { expect, test } from 'vitest'

import { resultPart, startClientServer, statusPart } from './client.fixtures.ts'
import { QueryClient, query } from './index.ts'
import { encodeParameters } from './parameters.ts'

test('a tagged query replays foreign-realm bytes and unknown protobuf fields unchanged', async (tc) => {
	let attempts = 0

	using server = await startClientServer({
		async *executeQuery() {
			yield ++attempts === 1 ? statusPart(Status.OVERLOADED) : resultPart([1])
		},
	})

	await using client = new QueryClient(server.driver)
	let sql = query(client)

	let bytes = runInNewContext('Uint8Array.of(0, 1, 2, 3).subarray(1, 3)') as Uint8Array
	let payload = new Bytes(bytes)
	let field = { no: 1000, wireType: WireType.Varint, data: Uint8Array.of(7) }

	payload.type.encode().$unknown = [field]
	payload.encode().$unknown = [field]

	let statement = sql`SELECT ${payload}`.signal(tc.signal)

	statement.on('retry', () => {
		bytes.fill(9)
		field.no = 1001
		field.data.fill(8)
	})

	await statement

	expect(server.executions).toHaveLength(2)

	for (let request of server.executions) {
		let parameter = request.parameters.$p0!
		let value = parameter.value!.value

		expect(value.case === 'bytesValue' && Array.from(value.value)).toEqual([1, 2])

		for (let message of [parameter.type!, parameter.value!]) {
			expect(message.$unknown).toHaveLength(1)

			let received = message.$unknown![0]!

			expect(received.no).toBe(1000)
			expect(received.wireType).toBe(WireType.Varint)
			expect(Array.from(received.data)).toEqual([7])
		}
	}
})

test('query parameter encoding rejects an out-of-range protobuf scalar', () => {
	let input = new Int32(1)
	input.encode().value = { case: 'int32Value', value: 2 ** 31 }

	expect(() => {
		encodeParameters({ input })
	}).toThrow(/out of range/)
})
