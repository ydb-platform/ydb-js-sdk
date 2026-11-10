import { type ServerHttp2Stream, constants, createServer } from 'node:http2'

import { abortable } from '@ydbjs/abortable'
import { expect, test } from 'vitest'

import { collect, deferred, frame, rawServer, reply, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { MessageSizeError, Status } from './error.ts'
import type { SerializedMessage } from './index.ts'

let method = {
	...service.clientStream,
	requestSerialize(value: SerializedMessage) {
		return value
	},
	requestDeserialize(bytes: Uint8Array) {
		return bytes
	},
}

test('frames each segmented request once and preserves slice boundaries and empty messages', async (tc) => {
	let received: Buffer[] = []
	await using peer = await rawServer(async (stream) => {
		for await (let chunk of stream) {
			received.push(chunk)
		}
		reply(stream, ['received'])
	})
	using client = new Client(peer.authority, { maxSendBytes: 4 })
	let source = new Uint8Array([99, 1, 2, 3, 4, 99])
	let empty = source.subarray(2, 2)
	let segments = Object.freeze([
		empty,
		source.subarray(1, 3),
		empty,
		source.subarray(3, 5),
		empty,
	])
	async function* input() {
		yield segments
		yield []
		yield [empty, empty]
		yield source.subarray(1, 5)
	}

	let responses = await collect(client.call(method, input(), { signal: tc.signal }))

	expect(responses).toEqual(['received'])
	expect(Buffer.concat(received)).toEqual(
		Buffer.concat([
			frame(new Uint8Array([1, 2, 3, 4])),
			frame(''),
			frame(''),
			frame(source.subarray(1, 5)),
		])
	)
	expect(source).toEqual(new Uint8Array([99, 1, 2, 3, 4, 99]))
	expect(peer.errors).toEqual([])
})

for (let [name, limit, chunkBytes, chunkCount] of [
	['configured limit', 4, 3, 2],
	['gRPC uint32 length', 0x100000000, 1024 * 1024, 4096],
] as const) {
	test(`rejects segmented requests above the ${name} before sending a frame`, async (tc) => {
		let started = deferred()
		let closed = deferred()
		let receivedBytes = 0
		await using peer = await rawServer((stream) => {
			stream.on('data', (chunk: Buffer) => {
				receivedBytes += chunk.byteLength
			})
			stream.once('close', () => {
				closed.resolve()
			})
			started.resolve()
		})
		using client = new Client(peer.authority, { maxSendBytes: limit })
		let chunk = new Uint8Array(chunkBytes)
		let segments = Array.from({ length: chunkCount }, () => {
			return chunk
		})
		async function* input() {
			await abortable(tc.signal, started.promise)
			yield segments
		}

		let failure = await collect(client.call(method, input(), { signal: tc.signal })).catch(
			(error: unknown) => {
				return error
			}
		)
		await abortable(tc.signal, closed.promise)

		expect(failure).toBeInstanceOf(MessageSizeError)
		expect(failure).toMatchObject({
			code: Status.RESOURCE_EXHAUSTED,
			direction: 'request',
			limit,
		})
		expect(receivedBytes).toBe(0)
		expect(peer.errors).toEqual([])
	})
}

test('resumes a segmented request after HTTP/2 backpressure without advancing its producer', async (tc) => {
	let started = deferred<ServerHttp2Stream>()
	let serialized = deferred()
	let received: Buffer[] = []
	await using peer = await rawServer(
		async (stream) => {
			started.resolve(stream)
			for await (let chunk of stream) {
				received.push(chunk)
			}
			reply(stream, ['received'])
		},
		createServer({ settings: { initialWindowSize: 0 } })
	)
	using client = new Client(peer.authority)
	let segments = Array.from({ length: 8 }, (_, index) => {
		return new Uint8Array(64 * 1024).fill(index)
	})
	let produced = 0
	async function* input() {
		produced++
		yield segments
		produced++
		yield []
	}

	let response = collect(
		client.call(
			{
				...method,
				requestSerialize(value: SerializedMessage) {
					serialized.resolve()
					return value
				},
			},
			input(),
			{ signal: tc.signal }
		)
	)
	let stream = await abortable(tc.signal, started.promise)
	await abortable(tc.signal, serialized.promise)

	expect(produced).toBe(1)
	expect(received).toEqual([])

	stream.session!.settings({ initialWindowSize: 65535 })
	let responses = await response
	let receivedBytes = Buffer.concat(received)
	let expectedBytes = Buffer.concat([frame(Buffer.concat(segments)), frame('')])

	expect(responses).toEqual(['received'])
	expect(produced).toBe(2)
	expect(receivedBytes.equals(expectedBytes)).toBe(true)
	expect(peer.errors).toEqual([])
})

test('cancels a segmented request waiting for drain and closes its producer', async (tc) => {
	let started = deferred()
	let serialized = deferred()
	let reset = deferred<number>()
	let receivedBytes = 0
	await using peer = await rawServer(
		(stream) => {
			stream.on('data', (chunk: Buffer) => {
				receivedBytes += chunk.byteLength
			})
			stream.once('close', () => {
				reset.resolve(stream.rstCode)
			})
			started.resolve()
		},
		createServer({ settings: { initialWindowSize: 0 } })
	)
	using client = new Client(peer.authority)
	let segments = [new Uint8Array(128 * 1024), new Uint8Array(128 * 1024)]
	let produced = 0
	let closed = deferred()
	async function* input() {
		try {
			produced++
			yield segments
			produced++
			yield []
		} finally {
			closed.resolve()
		}
	}
	let controller = new AbortController()
	let reason = new Error('cancel blocked segmented request')

	let failure = collect(
		client.call(
			{
				...method,
				requestSerialize(value: SerializedMessage) {
					serialized.resolve()
					return value
				},
			},
			input(),
			{ signal: AbortSignal.any([tc.signal, controller.signal]) }
		)
	).catch((error: unknown) => {
		return error
	})
	await abortable(tc.signal, started.promise)
	await abortable(tc.signal, serialized.promise)

	expect(produced).toBe(1)

	controller.abort(reason)
	let error = await failure
	await abortable(tc.signal, closed.promise)
	let resetCode = await abortable(tc.signal, reset.promise)

	expect(error).toBe(reason)
	expect(produced).toBe(1)
	expect(resetCode).toBe(constants.NGHTTP2_CANCEL)
	expect(receivedBytes).toBe(0)
	expect(peer.errors).toEqual([])
})
