import { create } from '@bufbuild/protobuf'

import { expect, test } from 'vitest'

import { Status } from '../src/error.js'
import type { Metadata } from '../src/types.js'
import { EmptySchema, StreamingInputCallRequestSchema } from './interop_pb.js'
import { goPeer } from './peer.js'

async function collectSizes(
	responses: AsyncIterable<{ payload?: { body: Uint8Array } }>
): Promise<number[]> {
	let sizes: number[] = []
	for await (let response of responses) {
		expect(response.payload?.body.every((byte) => byte === 0)).toBe(true)
		sizes.push(response.payload!.body.length)
	}
	return sizes
}

test('exchanges an empty unary message with the official Go interop service', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let response = peer.client.empty({}, { signal: tc.signal })
	await expect(response).resolves.toEqual(create(EmptySchema))
})

test('exchanges large unary payloads with the official Go interop service', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let response = await peer.client.unary(
		{ responseSize: 314159, payload: { body: new Uint8Array(271828) } },
		{ signal: tc.signal }
	)
	expect(response.payload?.body.length).toBe(314159)
	expect(response.payload?.body.every((byte) => byte === 0)).toBe(true)
})

test('aggregates a client stream through the official Go interop service', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let sizes = [27182, 8, 1828, 45904]
	async function* requests() {
		for (let size of sizes) {
			yield create(StreamingInputCallRequestSchema, {
				payload: { body: new Uint8Array(size) },
			})
		}
	}
	let response = await peer.client.client(requests(), { signal: tc.signal })
	expect(response.aggregatedPayloadSize).toBe(sizes.reduce((sum, size) => sum + size, 0))
})

test('receives every response in a server stream from the official Go interop service', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let sizes = [31415, 9, 2653, 58979]
	let responses = peer.client.server(
		{ responseParameters: sizes.map((size) => ({ size })) },
		{ signal: tc.signal }
	)
	let receivedSizes = collectSizes(responses)
	await expect(receivedSizes).resolves.toEqual(sizes)
})

test('receives a bidi response before half-closing its request stream', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let continueInput = Promise.withResolvers<void>()
	async function* requests() {
		yield { responseParameters: [{ size: 31415 }], payload: { body: new Uint8Array(27182) } }
		await continueInput.promise
		yield { responseParameters: [{ size: 9 }], payload: { body: new Uint8Array(8) } }
	}
	let responses = peer.client.bidi(requests(), { signal: tc.signal })[Symbol.asyncIterator]()
	try {
		let first = await responses.next()
		expect(first.value?.payload?.body.length).toBe(31415)
		continueInput.resolve()
		let second = await responses.next()
		expect(second.value?.payload?.body.length).toBe(9)
		let end = await responses.next()
		expect(end.done).toBe(true)
	} finally {
		continueInput.resolve()
	}
})

test('finishes an empty bidi stream with the official Go interop service', async (tc) => {
	await using peer = await goPeer(tc.signal)
	async function* requests() {}
	let responses = peer.client.bidi(requests(), { signal: tc.signal })
	let receivedSizes = collectSizes(responses)
	await expect(receivedSizes).resolves.toEqual([])
})

test('preserves request, response and binary trailer metadata across Go interop', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let headers: Metadata | undefined
	let trailers: Metadata | undefined
	let binary = new Uint8Array([0, 10, 255, 11])
	await peer.client.unary(
		{},
		{
			signal: tc.signal,
			metadata: {
				'x-grpc-test-echo-initial': 'initial value',
				'x-grpc-test-echo-trailing-bin': binary,
			},
			onHeader: (value) => {
				headers = value
			},
			onTrailer: (value) => {
				trailers = value
			},
		}
	)
	expect(headers?.['x-grpc-test-echo-initial']).toBe('initial value')
	expect(Array.from(trailers?.['x-grpc-test-echo-trailing-bin'] as Uint8Array)).toEqual(
		Array.from(binary)
	)
})

test('preserves a non-OK Go status and Unicode details', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let details = '\t\ntest with whitespace\r\nand Unicode BMP ☺ and non-BMP 😃\t\n'
	let response = peer.client.unary(
		{ responseStatus: { code: Status.RESOURCE_EXHAUSTED, message: details } },
		{ signal: tc.signal }
	)
	await expect(response).rejects.toMatchObject({
		code: Status.RESOURCE_EXHAUSTED,
		details,
	})
})

test('cancels a pending Go server response after receiving its first message', async (tc) => {
	await using peer = await goPeer(tc.signal)
	let controller = new AbortController()
	let reason = new Error('cancel after first response')
	let responses = peer.client.server(
		{ responseParameters: [{ size: 1 }, { size: 1, intervalUs: 1000000 }] },
		{ signal: AbortSignal.any([tc.signal, controller.signal]) }
	)
	let iterator = responses[Symbol.asyncIterator]()
	let first = await iterator.next()
	expect(first.value?.payload?.body.length).toBe(1)
	let failure = iterator.next().catch((error: unknown) => error)
	controller.abort(reason)
	let error = await failure
	expect(error).toBe(reason)
})

test('expires a deadline after the Go server accepts the bidi RPC', async (tc) => {
	await using peer = await goPeer(tc.signal)
	await peer.transport.connect(tc.signal)
	let headers: Metadata | undefined
	async function* requests() {
		yield { responseParameters: [{ size: 1, intervalUs: 1000000 }] }
	}
	let responses = peer.client.bidi(requests(), {
		signal: tc.signal,
		deadline: Date.now() + 100,
		metadata: { 'x-grpc-test-echo-initial': 'accepted before deadline' },
		onHeader: (value) => {
			headers = value
		},
	})
	let receivedSizes = collectSizes(responses)
	await expect(receivedSizes).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED })
	expect(headers?.['x-grpc-test-echo-initial']).toBe('accepted before deadline')
})

test('decodes a gzip-compressed unary response from the Go service', async (tc) => {
	await using peer = await goPeer(tc.signal, true)
	let response = await peer.client.unary({ responseSize: 314159 }, { signal: tc.signal })
	expect(response.payload?.body.length).toBe(314159)
	expect(response.payload?.body.every((byte) => byte === 0)).toBe(true)
})

test('decodes gzip-compressed streaming responses from the Go service', async (tc) => {
	await using peer = await goPeer(tc.signal, true)
	let sizes = [31415, 9, 2653, 58979]
	let responses = peer.client.server(
		{ responseParameters: sizes.map((size) => ({ size })) },
		{ signal: tc.signal }
	)
	let receivedSizes = collectSizes(responses)
	await expect(receivedSizes).resolves.toEqual(sizes)
})

test('drains a large gzip response backlog after the Go server sends its trailers', async (tc) => {
	await using peer = await goPeer(tc.signal, true)
	let sizes = Array<number>(1000).fill(32768)
	let responses = peer.client.server(
		{ responseParameters: sizes.map((size) => ({ size })) },
		{ signal: tc.signal }
	)
	let receivedSizes = collectSizes(responses)
	await expect(receivedSizes).resolves.toEqual(sizes)
})
