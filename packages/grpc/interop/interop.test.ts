import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'

import { expect, test } from 'vitest'

import { RpcError, Status } from '../src/error.js'
import { Server } from '../src/server.js'
import type { Metadata } from '../src/types.js'
import {
	EmptySchema,
	StreamingInputCallRequestSchema,
	type StreamingOutputCallResponse,
} from './interop_pb.js'
import { definition, goClient, goPeer } from './peer.js'

async function collectSizes(
	responses: AsyncIterable<StreamingOutputCallResponse>
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

test('serves a large unary response to the grpc-go client', async (tc) => {
	using server = new Server()
	server.add(definition, {
		unary(request) {
			expect(request.payload?.body.length).toBe(271828)
			expect(request.payload?.body.every((byte) => byte === 0)).toBe(true)
			return { payload: { body: new Uint8Array(request.responseSize) } }
		},
	})
	let port = await server.listen()

	let result = goClient(`127.0.0.1:${port}`, 'unary', tc.signal)
	await expect(result).resolves.toBeUndefined()
})

test('aggregates a request stream sent by the grpc-go client', async (tc) => {
	using server = new Server()
	let received: number[] = []
	server.add(definition, {
		async client(requests) {
			for await (let request of requests) {
				expect(request.payload?.body.every((byte) => byte === 0)).toBe(true)
				received.push(request.payload!.body.length)
			}
			return { aggregatedPayloadSize: received.reduce((sum, size) => sum + size, 0) }
		},
	})
	let port = await server.listen()

	await goClient(`127.0.0.1:${port}`, 'client-stream', tc.signal)

	expect(received).toEqual([27182, 8, 1828, 45904])
})

test('streams every requested response to the grpc-go client', async (tc) => {
	using server = new Server()
	server.add(definition, {
		async *server(request) {
			for (let parameter of request.responseParameters) {
				yield { payload: { body: new Uint8Array(parameter.size) } }
			}
		},
	})
	let port = await server.listen()

	let result = goClient(`127.0.0.1:${port}`, 'server-stream', tc.signal)
	await expect(result).resolves.toBeUndefined()
})

test('answers each grpc-go bidi request before the client half-closes its stream', async (tc) => {
	using server = new Server()
	let received: number[] = []
	server.add(definition, {
		async *bidi(requests) {
			for await (let request of requests) {
				for (let parameter of request.responseParameters) {
					received.push(parameter.size)
					yield { payload: { body: new Uint8Array(parameter.size) } }
				}
			}
		},
	})
	let port = await server.listen()

	await goClient(`127.0.0.1:${port}`, 'bidi', tc.signal)

	expect(received).toEqual([31415, 9, 2653])
})

test('exchanges repeated and binary metadata with the grpc-go client', async (tc) => {
	using server = new Server()
	let binary = new Uint8Array([0, 10, 255, 11])
	server.add(definition, {
		empty(_request, context) {
			expect(context.metadata['x-repeated']).toEqual(['first', 'second'])
			expect(Array.from(context.metadata['x-request-bin'] as Uint8Array)).toEqual(
				Array.from(binary)
			)
			context.sendHeader({ 'x-repeated': ['first', 'second'], 'x-header-bin': binary })
			context.setTrailer({ 'x-trailer-bin': binary, 'x-trailer': 'finished' })
			return {}
		},
	})
	let port = await server.listen()

	let result = goClient(`127.0.0.1:${port}`, 'metadata', tc.signal)
	await expect(result).resolves.toBeUndefined()
})

test('sends an error status, Unicode details and trailers to the grpc-go client', async (tc) => {
	using server = new Server()
	server.add(definition, {
		unary(request) {
			let status = request.responseStatus!
			throw new RpcError(status.code, status.message, { 'x-error': 'quota' })
		},
	})
	let port = await server.listen()

	let result = goClient(`127.0.0.1:${port}`, 'status', tc.signal)
	await expect(result).resolves.toBeUndefined()
})

test('aborts its handler when the grpc-go client cancels a streaming response', async (tc) => {
	using server = new Server()
	let cancelled = Promise.withResolvers<boolean>()
	server.add(definition, {
		async *server(_request, context) {
			let aborted = once(context.signal, 'abort')
			yield { payload: { body: new Uint8Array(1) } }
			await aborted
			cancelled.resolve(context.signal.aborted)
		},
	})
	let port = await server.listen()

	await goClient(`127.0.0.1:${port}`, 'cancel', tc.signal)
	let aborted = await abortable(tc.signal, cancelled.promise)

	expect(aborted).toBe(true)
})

test('propagates the grpc-go client deadline to its handler', async (tc) => {
	using server = new Server()
	let expired = Promise.withResolvers<boolean>()
	let deadline: number | undefined
	server.add(definition, {
		async *server(_request, context) {
			deadline = context.deadline
			let aborted = once(context.signal, 'abort')
			yield { payload: { body: new Uint8Array(1) } }
			await aborted
			expired.resolve(context.signal.aborted)
		},
	})
	let port = await server.listen()
	let started = Date.now()

	await goClient(`127.0.0.1:${port}`, 'deadline', tc.signal)
	let aborted = await abortable(tc.signal, expired.promise)

	expect(aborted).toBe(true)
	expect(deadline).toBeGreaterThan(started)
	expect(deadline).toBeLessThanOrEqual(Date.now() + 100)
})

test('serves a trusted TLS connection from the grpc-go client', async (tc) => {
	await using files = {
		path: await mkdtemp(join(tmpdir(), 'ydb-grpc-go-tls-')),
		[Symbol.asyncDispose]() {
			return rm(this.path, { recursive: true, force: true })
		},
	}
	let keyPath = join(files.path, 'key.pem')
	let certPath = join(files.path, 'certificate.pem')
	await promisify(execFile)(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-subj',
			'/CN=grpc.test',
			'-addext',
			'subjectAltName=DNS:grpc.test',
			'-days',
			'1',
		],
		{ signal: tc.signal }
	)
	using server = new Server({
		tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
	})
	server.add(definition, {
		unary: (request) => ({ payload: { body: new Uint8Array(request.responseSize) } }),
	})
	let port = await server.listen()

	let result = goClient(`127.0.0.1:${port}`, 'unary', tc.signal, certPath)
	await expect(result).resolves.toBeUndefined()
})
