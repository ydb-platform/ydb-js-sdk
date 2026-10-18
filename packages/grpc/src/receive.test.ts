import { expect, test } from 'vitest'

import { deferred, service } from '../tests/fixtures.ts'
import { nodePeer } from '../tests/node-peer.ts'
import { Client } from './client.ts'
import { Status } from './error.ts'

// Protocol faults after accepted data require a controlled peer; YDB cannot schedule them deterministically.
for (let [name, fault, details] of [
	['malformed next frame', 'malformed', 'Invalid gRPC compression flag'],
	['truncated next frame', 'truncated', 'Truncated gRPC message'],
] as const) {
	test(`preserves the current response batch before a ${name}`, async (tc) => {
		let terminal = deferred()
		await using peer = await nodePeer({ type: 'receive-tail', fault }, tc.signal)
		using client = new Client(peer.authority)
		let response = client.call(service.serverStream, '', {
			signal: tc.signal,
			onStatus: () => terminal.resolve(),
		})
		let iterator = response[Symbol.asyncIterator]()

		expect((await iterator.next()).value).toBe('first')
		await peer.command('send-tail')
		if (name === 'truncated next frame') {
			await terminal.promise
		}
		expect((await iterator.next()).value).toBe('second')
		await expect(iterator.next()).rejects.toMatchObject({ code: Status.INTERNAL, details })
	})
}

test('preserves the decompression error and cause after accepted responses', async (tc) => {
	await using peer = await nodePeer({ type: 'receive-tail', fault: 'gzip' }, tc.signal)
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', { signal: tc.signal })
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	await peer.command('send-tail')
	expect((await iterator.next()).value).toBe('second')
	await expect(iterator.next()).rejects.toMatchObject({
		code: Status.INTERNAL,
		details: 'Failed to decompress gRPC message',
		cause: { code: 'Z_DATA_ERROR' },
	})
})

test('cancels a read while the frame body is incomplete', async (tc) => {
	await using peer = await nodePeer({ type: 'partial-body' }, tc.signal)
	using client = new Client(peer.authority)
	let controller = new AbortController()
	let reason = new Error('cancel partial response')
	let response = client.call(service.serverStream, '', {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let iterator = response[Symbol.asyncIterator]()
	let pending = iterator.next()
	let failure = pending.catch((error: unknown) => error)
	await peer.wait('first-sent')
	await peer.command('ping')

	controller.abort(reason)

	expect(await failure).toBe(reason)
})

test('settles a pending response read when the HTTP/2 session closes prematurely', async (tc) => {
	await using peer = await nodePeer({ type: 'premature-close' }, tc.signal)
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', { signal: tc.signal })
	let iterator = response[Symbol.asyncIterator]()
	expect((await iterator.next()).value).toBe('first')
	let pending = iterator.next()
	let failure = pending.catch((error: unknown) => error)
	await peer.wait('first-sent')

	await peer.command('destroy-session')

	expect(await failure).toMatchObject({ code: Status.UNAVAILABLE })
})
