import { expect, test } from 'vitest'

import { frame, rawServer, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { RpcError, Status } from './error.ts'
import type { RpcStatus } from './types.ts'

// A controlled HTTP/2 peer can coalesce valid responses with malformed framing
// that a real YDB server cannot produce on demand.
for (let [name, tail, failure] of [
	[
		'an invalid compression flag',
		Buffer.from([2, 0, 0, 0, 0]),
		{ code: Status.INTERNAL, details: 'Invalid gRPC compression flag' },
	],
	[
		'an oversized frame',
		Buffer.from([0, 0, 0, 1, 0]),
		{
			code: Status.RESOURCE_EXHAUSTED,
			details: 'response message exceeds 128 bytes',
			direction: 'response',
			limit: 128,
		},
	],
] as const) {
	test(`delivers complete responses before ${name} in the same chunk`, async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
			stream.end(Buffer.concat([frame('first'), frame(''), frame('second'), tail]))
		})
		using client = new Client(peer.authority, { maxReceiveBytes: 128 })
		let statuses: RpcStatus[] = []
		let responses = client.call(service.serverStream, '', {
			signal: tc.signal,
			onStatus: (status) => statuses.push(status),
		})

		await expect(responses.next()).resolves.toEqual({ value: 'first', done: false })
		await expect(responses.next()).resolves.toEqual({ value: '', done: false })
		await expect(responses.next()).resolves.toEqual({ value: 'second', done: false })
		let error = await responses.next().catch((reason: unknown) => reason)
		expect(error).toBeInstanceOf(RpcError)
		expect(error).toMatchObject(failure)
		expect(statuses).toHaveLength(1)
		expect(error).toBe(statuses[0])
	})
}

test('reports a coalesced framing error while the peer keeps the response open', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.write(Buffer.concat([frame('first'), Buffer.from([2, 0, 0, 0, 0])]))
	})
	using client = new Client(peer.authority)
	let responses = client.call(service.serverStream, '', { signal: tc.signal })

	await expect(responses.next()).resolves.toEqual({ value: 'first', done: false })
	await expect(responses.next()).rejects.toMatchObject({
		code: Status.INTERNAL,
		details: 'Invalid gRPC compression flag',
	})
})

test('cancels when the consumer returns before a coalesced framing error', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.write(Buffer.concat([frame('first'), frame('second'), Buffer.from([2, 0, 0, 0, 0])]))
	})
	using client = new Client(peer.authority)
	let statuses: RpcStatus[] = []
	let responses = client.call(service.serverStream, '', {
		signal: tc.signal,
		onStatus: (status) => statuses.push(status),
	})

	await expect(responses.next()).resolves.toEqual({ value: 'first', done: false })
	await expect(responses.return()).resolves.toEqual({ value: undefined, done: true })
	expect(statuses).toMatchObject([
		{ code: Status.CANCELLED, details: 'Response consumer stopped' },
	])
})

test('preserves caller cancellation before a coalesced framing error', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.write(Buffer.concat([frame('first'), frame('second'), Buffer.from([2, 0, 0, 0, 0])]))
	})
	using client = new Client(peer.authority)
	let controller = new AbortController()
	let reason = new Error('stop consuming the batch')
	let statuses: RpcStatus[] = []
	let responses = client.call(service.serverStream, '', {
		signal: AbortSignal.any([tc.signal, controller.signal]),
		onStatus: (status) => statuses.push(status),
	})

	await expect(responses.next()).resolves.toEqual({ value: 'first', done: false })
	controller.abort(reason)
	await expect(responses.next()).rejects.toBe(reason)
	expect(statuses).toMatchObject([{ code: Status.CANCELLED, details: reason.message }])
})
