import { constants } from 'node:http2'
import { setTimeout } from 'node:timers/promises'

import {
	Metadata,
	Server,
	ServerCredentials,
	type handleBidiStreamingCall,
	type handleClientStreamingCall,
	type handleServerStreamingCall,
	type handleUnaryCall,
	status,
} from '@grpc/grpc-js'
import { expect, test } from 'vitest'

import { nodePeer } from '../tests/node-peer.ts'
import { Client } from './client.ts'
import { createServiceClient } from './service.ts'
import type { Metadata as CallMetadata } from './types.ts'

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

interface Handlers {
	unary?: handleUnaryCall<Message, Message>
	server?: handleServerStreamingCall<Message, Message>
	client?: handleClientStreamingCall<Message, Message>
	bidi?: handleBidiStreamingCall<Message, Message>
}

// A loopback peer makes transport EOF, cancellation and non-OK trailers deterministic.
async function inProcessGrpcPeer(handlers: Handlers) {
	let server = new Server()
	server.addService(definition, { ...handlers })
	let port = await new Promise<number>((resolve, reject) => {
		server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, boundPort) => {
			if (error) {
				reject(error)
			} else {
				resolve(boundPort)
			}
		})
	})
	let client = new Client(`http://127.0.0.1:${port}`)

	return {
		client: createServiceClient(definition, client),
		[Symbol.dispose]() {
			client.close()
			server.forceShutdown()
		},
	}
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
	let requestMetadata: Metadata | undefined
	using peer = await inProcessGrpcPeer({
		unary(call, respond) {
			requestMetadata = call.metadata
			let header = new Metadata()
			header.set('x-header', 'header')
			call.sendMetadata(header)
			let trailer = new Metadata()
			trailer.set('x-trailer', 'trailer')
			respond(null, { value: call.request.value + 1 }, trailer)
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
	expect(requestMetadata?.get('x-request')).toEqual(['request'])
	expect(requestMetadata?.get('x-data-bin')).toEqual([Buffer.from([1, 2, 3])])
	expect(header?.['x-header']).toEqual('header')
	let responseTrailer = await trailer.promise
	expect(responseTrailer['x-trailer']).toEqual('trailer')
	expect(metadata).toEqual({
		'x-request': 'request',
		'x-data-bin': new Uint8Array([1, 2, 3]),
	})
})

test('preserves unary status, details and binary trailers', async (tc) => {
	let metadata = new Metadata()
	metadata.set('x-error-bin', Buffer.from([4, 5]))
	using peer = await inProcessGrpcPeer({
		unary(_call, respond) {
			respond({ code: status.RESOURCE_EXHAUSTED, details: 'capacity', metadata })
		},
	})

	let error = await peer.client
		.unary({ value: 1 }, { signal: tc.signal })
		.catch((failure: unknown) => failure)
	expect(error).toBeInstanceOf(Error)
	expect(error).toMatchObject({ code: status.RESOURCE_EXHAUSTED, details: 'capacity' })
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
		unary(call) {
			call.on('cancelled', cancelled.resolve)
			started.resolve()
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
	using peer = await inProcessGrpcPeer({ unary() {} })

	let response = peer.client.unary({ value: 1 }, { signal: tc.signal, deadline: Date.now() + 50 })
	await expect(response).rejects.toMatchObject({ code: status.DEADLINE_EXCEEDED })
})

test('starts a response stream only when iteration begins', async (tc) => {
	let calls = 0
	using peer = await inProcessGrpcPeer({
		server(call) {
			calls++
			call.write({ value: call.request.value })
			call.end()
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
		server(call) {
			call.write({ value: 1 })
			call.write({ value: 2 })
			call.end()
		},
	})

	let responses = peer.client.server({ value: 0 }, { signal: tc.signal })
	let values = await collect(responses)
	expect(values).toEqual([1, 2])
})

test('rejects response iteration on non-OK trailers', async (tc) => {
	using peer = await inProcessGrpcPeer({
		server(call) {
			call.emit('error', { code: status.PERMISSION_DENIED, details: 'denied' })
		},
	})

	let responses = peer.client.server({ value: 0 }, { signal: tc.signal })
	let values = collect(responses)
	await expect(values).rejects.toMatchObject({
		code: status.PERMISSION_DENIED,
		details: 'denied',
	})
})

test('cancels the RPC when a response consumer breaks early', async (tc) => {
	let cancelled = Promise.withResolvers<void>()
	using peer = await inProcessGrpcPeer({
		server(call) {
			call.on('cancelled', cancelled.resolve)
			call.write({ value: 1 })
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
		server() {
			started.resolve()
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
		bidi(call) {
			let received: Message[] = []
			call.on('data', (message: Message) => received.push(message))
			call.on('end', () => {
				for (let message of received) {
					call.write(message)
				}
				call.end()
			})
		},
	})

	let responses = peer.client.bidi(messages(1, 2, 3), { signal: tc.signal })
	let values = await collect(responses)
	expect(values).toEqual([1, 2, 3])
})

test('returns a client-streaming response after input ends', async (tc) => {
	using peer = await inProcessGrpcPeer({
		client(call, respond) {
			let sum = 0
			call.on('data', (message: Message) => {
				sum += message.value
			})
			call.on('end', () => respond(null, { value: sum }))
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
		bidi(call) {
			call.on('cancelled', cancelled.resolve)
			call.on('data', started.resolve)
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
		client(call) {
			call.resume()
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
	await using peer = await nodePeer({ type: 'backpressure', initialWindowSize: 65535 }, tc.signal)
	using transport = new Client(peer.authority)
	let client = createServiceClient(definition, transport)
	async function* input() {
		for (let value = 0; value < 256; value++) {
			produced++
			yield { value, padding }
		}
	}
	let pendingResponse = client.client(input(), { signal: tc.signal })
	await peer.wait('request-started')
	try {
		await setTimeout(50, undefined, { signal: tc.signal })
		expect(produced).toBeGreaterThan(0)
		expect(produced).toBeLessThan(256)
		let blocked = await peer.snapshot()
		expect(blocked.consumedRequestBytes).toBe(0)
	} finally {
		await peer.command('resume-requests')
	}

	let response = await pendingResponse
	expect(response.value).toBe(256)
	let received = await peer.snapshot()
	expect(received.requestMessages).toBe(256)
})

test('aborts a drain wait and closes the request producer', async (tc) => {
	let produced = 0
	let closed = false
	let padding = new Uint8Array(128 * 1024)
	await using peer = await nodePeer({ type: 'backpressure', initialWindowSize: 0 }, tc.signal)
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
	await peer.wait('request-started')
	await setTimeout(50, undefined, { signal: tc.signal })
	expect(produced).toBeGreaterThan(0)
	expect(produced).toBeLessThan(256)
	let blocked = await peer.snapshot()
	expect(blocked.consumedRequestBytes).toBe(0)
	controller.abort(reason)
	let error = await failure
	expect(error).toBe(reason)
	expect(closed).toBe(true)
	let resetCode = await peer.wait('request-closed')
	expect(resetCode).toBe(constants.NGHTTP2_CANCEL)
	let received = await peer.snapshot()
	expect(received.consumedRequestBytes).toBe(0)
	expect(received.bufferedRequestBytes).toBe(0)
	expect(received.requestMessages).toBe(0)
	expect(received.requestResetCodes).toEqual([constants.NGHTTP2_CANCEL])
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
		bidi(call) {
			call.on('data', () => call.end())
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
		client(call, respond) {
			call.once('data', () => respond(null, { value: 42 }))
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
		bidi(call) {
			call.on('data', (message: Message) => {
				received.push(message.value)
				started.resolve()
			})
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
		bidi(call) {
			call.once('data', (message: Message) => call.write(message))
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
	let end = Promise.withResolvers<() => void>()
	using peer = await inProcessGrpcPeer({
		bidi(call) {
			call.once('data', (message: Message) => {
				call.write(message)
				end.resolve(() => call.end())
			})
		},
	})
	let producer = blockedInput()
	let stream = peer.client.bidi(producer.input, { signal: tc.signal })[Symbol.asyncIterator]()

	try {
		let first = await stream.next()
		expect(first.value?.value).toBe(1)
		let finish = await end.promise
		finish()
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
		bidi(call) {
			call.resume()
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
