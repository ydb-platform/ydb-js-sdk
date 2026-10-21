import { expect, test } from 'vitest'

import { method, rawServer, reply, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { createServiceClient } from './service.ts'
import type { Transport } from './types.ts'

test('rejects a close RPC without calling or closing the transport', () => {
	let calls = 0
	let closes = 0
	let transport: Transport = {
		call() {
			calls++
			throw new Error('Unexpected RPC')
		},
		close() {
			closes++
		},
	}
	let definition = { close: method('Close', false, false) }

	expect(() => createServiceClient(definition, transport)).toThrow(
		new TypeError('Service method "close" conflicts with the client lifecycle method')
	)
	expect(calls).toBe(0)
	expect(closes).toBe(0)
})

test('closes the transport after calling a nonconflicting service', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['response']))
	using transport = new Client(peer.authority)
	let client = createServiceClient(service, transport)

	await expect(client.unary('request', { signal: tc.signal })).resolves.toBe('response')
	expect(transport.state).toBe('ready')
	client.close()
	expect(transport.state).toBe('closed')
	expect(peer.streams).toHaveLength(1)
})
