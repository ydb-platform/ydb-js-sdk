// Some peer handlers intentionally consume requests without producing any response.
/* oxlint-disable require-yield */
import { type ServerHttp2Stream, constants, createServer } from 'node:http2'
import { setTimeout } from 'node:timers/promises'

import { abortable } from '@ydbjs/abortable'

import { expect, test } from 'vitest'

import { rawServer, reply, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { RpcError, Status } from './error.ts'
import { FrameDecoder } from './framing.ts'
import { Server } from './server.ts'
import { createServiceClient } from './service.ts'
import type { Metadata as CallMetadata, ServiceImplementation, Transport } from './types.ts'

interface Message {
	value: number
	padding?: Uint8Array
}

function serialize(message: Message): Buffer {
	let bytes = Buffer.allocUnsafe(4 + (message.padding?.length ?? 0))
	bytes.writeUInt32LE(message.value)
	if (message.padding) {
		bytes.set(message.padding, 4)
	}

	return bytes
}

function deserialize(bytes: Uint8Array): Message {
	let buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	return { value: buffer.readUInt32LE(), padding: buffer.subarray(4) }
}

function method<RequestStream extends boolean, ResponseStream extends boolean>(
	name: string,
	requestStream: RequestStream,
	responseStream: ResponseStream
) {
	return {
		path: `/test.Stream/${name}`,
		requestStream,
		responseStream,
		requestSerialize: serialize,
		requestDeserialize: deserialize,
		responseSerialize: serialize,
		responseDeserialize: deserialize,
	}
}

let definition = {
	unary: method('Unary', false, false),
	server: method('Server', false, true),
	client: method('Client', true, false),
	bidi: method('Bidi', true, true),
}

// A loopback peer makes transport EOF, cancellation and non-OK trailers deterministic.
async function inProcessGrpcPeer(handlers: Partial<ServiceImplementation<typeof definition>>) {
	let server = new Server()
	server.add(definition, handlers)
	let port = await server.listen()
	let transport = new Client(`http://127.0.0.1:${port}`)

	return {
		client: createServiceClient(definition, transport),
		[Symbol.dispose]() {
			transport.close()
			server.destroy()
		},
	}
}

function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason)
		else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
	})
}

async function* messages(...values: number[]) {
	for (let value of values) {
		yield { value }
	}
}

async function collect(stream: AsyncIterable<Message>): Promise<number[]> {
	let values: number[] = []
	for await (let message of stream) {
		values.push(message.value)
	}

	return values
}

test('awaits a unary response with request, header and trailer metadata', async (tc) => {
	let requestMetadata: CallMetadata | undefined
	using peer = await inProcessGrpcPeer({
		unary(request, context) {
			requestMetadata = context.metadata
			context.sendHeader({ 'x-header': 'header' })
			context.setTrailer({ 'x-trailer': 'trailer' })
			return { value: request.value + 1 }
		},
	})
	let metadata = { 'x-request': 'request', 'x-data-bin': new Uint8Array([1, 2, 3]) }
	let header: CallMetadata | undefined
	let trailer = Promise.withResolvers<CallMetadata>()

	let response = await peer.client.unary(
		{ value: 41 },
		{
			metadata,
			signal: tc.signal,
			onHeader: (value) => {
				header = value
			},
			onTrailer: trailer.resolve,
		}
	)

	expect(response).toEqual({ value: 42, padding: Buffer.alloc(0) })
	expect(requestMetadata?.['x-request']).toEqual('request')
	expect(requestMetadata?.['x-data-bin']).toEqual(Buffer.from([1, 2, 3]))
	expect(header?.['x-header']).toEqual('header')
	let responseTrailer = await trailer.promise
	expect(responseTrailer['x-trailer']).toEqual('trailer')
	expect(metadata).toEqual({
		'x-request': 'request',
		'x-data-bin': new Uint8Array([1, 2, 3]),
	})
})

test('preserves unary status, details and binary trailers', async (tc) => {
	let metadata = { 'x-error-bin': Buffer.from([4, 5]) }
	using peer = await inProcessGrpcPeer({
		unary() {
			throw new RpcError(Status.RESOURCE_EXHAUSTED, 'capacity', metadata)
		},
	})

	let error = await peer.client
		.unary({ value: 1 }, { signal: tc.signal })
		.catch((failure: unknown) => failure)
	expect(error).toBeInstanceOf(Error)
	expect(error).toMatchObject({ code: Status.RESOURCE_EXHAUSTED, details: 'capacity' })
	let bytes = (error as { metadata: CallMetadata }).metadata['x-error-bin'] as Uint8Array
	expect([...bytes]).toEqual([4, 5])
})

test('does not start already-aborted calls or consume their inputs', async () => {
	using peer = await inProcessGrpcPeer({})
	let reason = new Error('already cancelled')
	let signal = AbortSignal.abort(reason)
	let consumed = 0
	async function* input() {
		consumed++
		yield { value: 1 }
	}

	let unaryResponse = peer.client.unary({ value: 1 }, { signal })
	await expect(unaryResponse).rejects.toBe(reason)

	let serverResponses = collect(peer.client.server({ value: 1 }, { signal }))
	await expect(serverResponses).rejects.toBe(reason)

	let clientResponse = peer.client.client(input(), { signal })
	await expect(clientResponse).rejects.toBe(reason)

	let bidiResponses = collect(peer.client.bidi(input(), { signal }))
	await expect(bidiResponses).rejects.toBe(reason)
	expect(consumed).toBe(0)
})

test('cancels a pending unary call with the caller reason', async (tc) => {
	let started = Promise.withResolvers<void>()
	let cancelled = Promise.withResolvers<void>()
	using peer = await inProcessGrpcPeer({
		unary(_request, { signal }) {
			signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
			started.resolve()
			return waitForAbort(signal)
		},
	})
	let controller = new AbortController()
	let reason = new Error('caller cancelled')
	let pending = peer.client.unary(
		{ value: 1 },
		{ signal: AbortSignal.any([tc.signal, controller.signal]) }
	)
	let failure = pending.catch((error: unknown) => error)
	await started.promise
	controller.abort(reason)

	let error = await failure
	expect(error).toBe(reason)
	await cancelled.promise
})

test('enforces the call deadline', async (tc) => {
	using peer = await inProcessGrpcPeer({
		unary(_request, { signal }) {
			return waitForAbort(signal)
		},
	})

	let response = peer.client.unary({ value: 1 }, { signal: tc.signal, deadline: Date.now() + 50 })
	await expect(response).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED })
})

test('starts a response stream only when iteration begins', async (tc) => {
	let calls = 0
	using peer = await inProcessGrpcPeer({
		async *server(request) {
			calls++
			yield { value: request.value }
		},
	})
	let stream = peer.client.server({ value: 7 }, { signal: tc.signal })
	await setTimeout(10, undefined, { signal: tc.signal })
	expect(calls).toBe(0)
	let values = await collect(stream)
	expect(values).toEqual([7])
	expect(calls).toBe(1)
})

test('yields every server response and completes after OK trailers', async (tc) => {
	using peer = await inProcessGrpcPeer({
		async *server() {
			yield { value: 1 }
			yield { value: 2 }
		},
	})

	let responses = peer.client.server({ value: 0 }, { signal: tc.signal })
	let values = await collect(responses)
	expect(values).toEqual([1, 2])
})

test('rejects response iteration on non-OK trailers', async (tc) => {
	using peer = await inProcessGrpcPeer({
		server() {
			throw new RpcError(Status.PERMISSION_DENIED, 'denied')
		},
	})

	let responses = peer.client.server({ value: 0 }, { signal: tc.signal })
	let values = collect(responses)
	await expect(values).rejects.toMatchObject({
		code: Status.PERMISSION_DENIED,
		details: 'denied',
	})
})

test('cancels the RPC when a response consumer breaks early', async (tc) => {
	let cancelled = Promise.withResolvers<void>()
	using peer = await inProcessGrpcPeer({
		async *server(_request, { signal }) {
			signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
			yield { value: 1 }
			await waitForAbort(signal)
		},
	})

	for await (let message of peer.client.server({ value: 0 }, { signal: tc.signal })) {
		expect(message.value).toBe(1)
		break
	}
	await cancelled.promise
})

test('aborts a pending response read with the caller reason', async (tc) => {
	let started = Promise.withResolvers<void>()
	using peer = await inProcessGrpcPeer({
		async *server(_request, { signal }) {
			started.resolve()
			await waitForAbort(signal)
		},
	})
	let controller = new AbortController()
	let reason = new Error('stop reading')
	let responses = peer.client.server(
		{ value: 0 },
		{ signal: AbortSignal.any([tc.signal, controller.signal]) }
	)
	let pending = collect(responses)
	let failure = pending.catch((error: unknown) => error)
	await started.promise
	controller.abort(reason)

	let error = await failure
	expect(error).toBe(reason)
})

test('half-closes bidirectional input and reads the remaining responses', async (tc) => {
	using peer = await inProcessGrpcPeer({
		async *bidi(requests) {
			let received: Message[] = []
			for await (let message of requests) received.push(message)
			yield* received
		},
	})

	let responses = peer.client.bidi(messages(1, 2, 3), { signal: tc.signal })
	let values = await collect(responses)
	expect(values).toEqual([1, 2, 3])
})

test('returns a client-streaming response after input ends', async (tc) => {
	using peer = await inProcessGrpcPeer({
		async client(requests) {
			let sum = 0
			for await (let message of requests) sum += message.value
			return { value: sum }
		},
	})

	let response = await peer.client.client(messages(1, 2, 3), { signal: tc.signal })
	expect(response.value).toBe(6)
})

test('propagates a bidirectional producer failure without replacing it with cancellation', async (tc) => {
	let started = Promise.withResolvers<void>()
	let cancelled = Promise.withResolvers<void>()
	let failure = new Error('producer failed')
	using peer = await inProcessGrpcPeer({
		async *bidi(requests, { signal }) {
			signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
			await requests[Symbol.asyncIterator]().next()
			started.resolve()
			await waitForAbort(signal)
		},
	})
	async function* input() {
		yield { value: 1 }
		await started.promise
		throw failure
	}

	let responses = peer.client.bidi(input(), { signal: tc.signal })
	let values = collect(responses)
	await expect(values).rejects.toBe(failure)
	await cancelled.promise
})

test('propagates a client-streaming producer failure', async (tc) => {
	let failure = new Error('producer failed')
	using peer = await inProcessGrpcPeer({
		async client(requests, { signal }) {
			await collect(requests)
			return waitForAbort(signal)
		},
	})
	async function* input() {
		yield { value: 1 }
		throw failure
	}

	let response = peer.client.client(input(), { signal: tc.signal })
	await expect(response).rejects.toBe(failure)
})

test('bounds request production while a peer stops reading', async (tc) => {
	let produced = 0
	let padding = new Uint8Array(128 * 1024)
	let started = Promise.withResolvers<ServerHttp2Stream>()
	let consumedBytes = 0
	let receivedMessages = 0
	await using peer = await rawServer((stream) => {
		let decoder = new FrameDecoder(padding.byteLength + 4, 'request')
		stream.on('data', (chunk: Buffer) => {
			consumedBytes += chunk.byteLength
			for (let frame of decoder.push(chunk)) {
				if (frame.compressed) throw new Error('Unexpected compressed request')
				receivedMessages++
			}
		})
		stream.once('end', () => {
			decoder.finish()
			reply(stream, [serialize({ value: receivedMessages })])
		})
		stream.pause()
		started.resolve(stream)
	})
	using transport = new Client(peer.authority)
	let client = createServiceClient(definition, transport)
	async function* input() {
		for (let value = 0; value < 256; value++) {
			produced++
			yield { value, padding }
		}
	}
	let pendingResponse = client.client(input(), { signal: tc.signal })
	let stream = await abortable(tc.signal, started.promise)
	try {
		await setTimeout(50, undefined, { signal: tc.signal })
		expect(produced).toBeGreaterThan(0)
		expect(produced).toBeLessThan(256)
		expect(consumedBytes).toBe(0)
	} finally {
		stream.resume()
	}

	let response = await pendingResponse
	expect(response.value).toBe(256)
	expect(receivedMessages).toBe(256)
})

test('aborts a drain wait and closes the request producer', async (tc) => {
	let produced = 0
	let closed = false
	let padding = new Uint8Array(128 * 1024)
	let started = Promise.withResolvers<ServerHttp2Stream>()
	let reset = Promise.withResolvers<number>()
	let consumedBytes = 0
	let receivedMessages = 0
	let resetCodes: number[] = []
	await using peer = await rawServer(
		(stream) => {
			let decoder = new FrameDecoder(padding.byteLength + 4, 'request')
			stream.on('data', (chunk: Buffer) => {
				consumedBytes += chunk.byteLength
				for (let frame of decoder.push(chunk)) {
					if (frame.compressed) throw new Error('Unexpected compressed request')
					receivedMessages++
				}
			})
			stream.once('close', () => {
				resetCodes.push(stream.rstCode)
				reset.resolve(stream.rstCode)
			})
			stream.pause()
			started.resolve(stream)
		},
		createServer({ settings: { initialWindowSize: 0 } })
	)
	using transport = new Client(peer.authority)
	let client = createServiceClient(definition, transport)
	async function* input() {
		try {
			for (let value = 0; value < 256; value++) {
				produced++
				yield { value, padding }
			}
		} finally {
			closed = true
		}
	}
	let controller = new AbortController()
	let reason = new Error('abort blocked writes')
	let responses = client.bidi(input(), {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let response = collect(responses)
	let failure = response.catch((error: unknown) => error)
	let stream = await abortable(tc.signal, started.promise)
	await setTimeout(50, undefined, { signal: tc.signal })
	expect(produced).toBeGreaterThan(0)
	expect(produced).toBeLessThan(256)
	expect(consumedBytes).toBe(0)
	controller.abort(reason)
	let error = await failure
	expect(error).toBe(reason)
	expect(closed).toBe(true)
	let resetCode = await abortable(tc.signal, reset.promise)
	expect(resetCode).toBe(constants.NGHTTP2_CANCEL)
	expect(consumedBytes).toBe(0)
	expect(stream.readableLength).toBe(0)
	expect(receivedMessages).toBe(0)
	expect(resetCodes).toEqual([constants.NGHTTP2_CANCEL])
})

function blockedInput() {
	let returned = Promise.withResolvers<void>()
	let released = Promise.withResolvers<IteratorResult<Message>>()
	let first = true
	return {
		returned: returned.promise,
		release: released.resolve,
		input: {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<Message>> {
						if (first) {
							first = false
							return { done: false, value: { value: 1 } }
						}
						return released.promise
					},
					async return(): Promise<IteratorResult<Message>> {
						returned.resolve()
						return { done: true, value: undefined }
					},
				}
			},
		},
	}
}

test('finishes a response stream without waiting for a blocked request producer', async (tc) => {
	using peer = await inProcessGrpcPeer({
		async *bidi(requests) {
			await requests[Symbol.asyncIterator]().next()
		},
	})
	let producer = blockedInput()
	try {
		let responses = peer.client.bidi(producer.input, { signal: tc.signal })
		let values = await collect(responses)
		expect(values).toEqual([])
		await producer.returned
	} finally {
		producer.release({ done: true, value: undefined })
	}
})

test('stops a client-streaming producer after an early server response', async (tc) => {
	using peer = await inProcessGrpcPeer({
		async client(requests) {
			await requests[Symbol.asyncIterator]().next()
			return { value: 42 }
		},
	})
	let producer = blockedInput()
	try {
		let response = await peer.client.client(producer.input, { signal: tc.signal })
		expect(response.value).toBe(42)
		await producer.returned
	} finally {
		producer.release({ done: true, value: undefined })
	}
})

test('cancels while a request next is blocked and never writes its late value', async (tc) => {
	let started = Promise.withResolvers<void>()
	let received: number[] = []
	using peer = await inProcessGrpcPeer({
		async *bidi(requests) {
			for await (let message of requests) {
				received.push(message.value)
				started.resolve()
			}
		},
	})
	let producer = blockedInput()
	let controller = new AbortController()
	let reason = new Error('stop producer')
	let responses = peer.client.bidi(producer.input, {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let response = collect(responses)
	let failure = response.catch((error: unknown) => error)
	try {
		await started.promise
		controller.abort(reason)
		let error = await failure
		expect(error).toBe(reason)
		await producer.returned
		producer.release({ done: false, value: { value: 2 } })
		await setTimeout(10, undefined, { signal: tc.signal })
		expect(received).toEqual([1])
	} finally {
		producer.release({ done: true, value: undefined })
	}
})

test('stops requests on abort while the response consumer is paused', async (tc) => {
	using peer = await inProcessGrpcPeer({
		async *bidi(requests, { signal }) {
			for await (let message of requests) {
				yield message
				break
			}
			await waitForAbort(signal)
		},
	})
	let producer = blockedInput()
	let controller = new AbortController()
	let reason = new Error('cancel paused reader')
	let responses = peer.client.bidi(producer.input, {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let stream = responses[Symbol.asyncIterator]()

	try {
		let first = await stream.next()
		expect(first.value?.value).toBe(1)
		controller.abort(reason)
		await producer.returned
		producer.release({ done: false, value: { value: 2 } })
		let next = stream.next()
		await expect(next).rejects.toBe(reason)
	} finally {
		producer.release({ done: true, value: undefined })
		await stream.return?.()
	}
})

test('stops requests at server EOF while the response consumer is paused', async (tc) => {
	let end = Promise.withResolvers<void>()
	using peer = await inProcessGrpcPeer({
		async *bidi(requests) {
			for await (let message of requests) {
				yield message
				break
			}
			await end.promise
		},
	})
	let producer = blockedInput()
	let stream = peer.client.bidi(producer.input, { signal: tc.signal })[Symbol.asyncIterator]()

	try {
		let first = await stream.next()
		expect(first.value?.value).toBe(1)
		end.resolve()
		await producer.returned
		producer.release({ done: false, value: { value: 2 } })
		let finalResponse = await stream.next()
		expect(finalResponse.done).toBe(true)
	} finally {
		producer.release({ done: true, value: undefined })
		await stream.return?.()
	}
})

test('handles a producer rejection that races synchronous cancellation', async (tc) => {
	using peer = await inProcessGrpcPeer({
		async *bidi(requests) {
			await collect(requests)
		},
	})
	let controller = new AbortController()
	let reason = new Error('cancel inside producer')
	let input: AsyncIterable<Message> = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					controller.abort(reason)
					return Promise.reject(new Error('producer also failed'))
				},
			}
		},
	}

	let responses = peer.client.bidi(input, {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let values = collect(responses)
	await expect(values).rejects.toBe(reason)
	await new Promise<void>((resolve) => setImmediate(resolve))
})

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
	let reserved = { close: method('Close', false, false) }

	expect(() => createServiceClient(reserved, transport)).toThrow(
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
