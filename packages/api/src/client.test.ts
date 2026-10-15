import { setTimeout } from 'node:timers/promises'

import {
	Client,
	InterceptingCall,
	type Interceptor,
	Metadata,
	Server,
	ServerCredentials,
	credentials,
	type handleBidiStreamingCall,
	type handleClientStreamingCall,
	type handleServerStreamingCall,
	type handleUnaryCall,
	status,
} from '@grpc/grpc-js'
import { expect, test } from 'vitest'

import { createServiceClient } from './client.js'

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

function deserialize(bytes: Buffer): Message {
	return { value: bytes.readUInt32LE(), padding: bytes.subarray(4) }
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
async function serve(handlers: Handlers) {
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
	let client = new Client(`127.0.0.1:${port}`, credentials.createInsecure())

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

test('awaits a unary response with native request, header and trailer metadata', async (tc) => {
	let requestMetadata: Metadata | undefined
	using peer = await serve({
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
	let metadata = new Metadata()
	metadata.set('x-request', 'request')
	metadata.set('x-data-bin', Buffer.from([1, 2, 3]))
	let header: Metadata | undefined
	let trailer = Promise.withResolvers<Metadata>()

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
	expect(header).toBeInstanceOf(Metadata)
	expect(header?.get('x-header')).toEqual(['header'])
	expect((await trailer.promise).get('x-trailer')).toEqual(['trailer'])
	expect(metadata.getMap()).toEqual({
		'x-request': 'request',
		'x-data-bin': Buffer.from([1, 2, 3]),
	})
})

test('preserves native unary status, details and binary trailers', async (tc) => {
	let metadata = new Metadata()
	metadata.set('x-error-bin', Buffer.from([4, 5]))
	using peer = await serve({
		unary(_call, respond) {
			respond({ code: status.RESOURCE_EXHAUSTED, details: 'capacity', metadata })
		},
	})

	let error = await peer.client
		.unary({ value: 1 }, { signal: tc.signal })
		.catch((failure: unknown) => failure)
	expect(error).toBeInstanceOf(Error)
	expect(error).toMatchObject({ code: status.RESOURCE_EXHAUSTED, details: 'capacity' })
	expect((error as { metadata: Metadata }).metadata).toBeInstanceOf(Metadata)
	expect((error as { metadata: Metadata }).metadata.get('x-error-bin')).toEqual([
		Buffer.from([4, 5]),
	])
})

test('does not start already-aborted calls or consume their inputs', async () => {
	using peer = await serve({})
	let reason = new Error('already cancelled')
	let signal = AbortSignal.abort(reason)
	let consumed = 0
	async function* input() {
		consumed++
		yield { value: 1 }
	}

	await expect(peer.client.unary({ value: 1 }, { signal })).rejects.toBe(reason)
	await expect(collect(peer.client.server({ value: 1 }, { signal }))).rejects.toBe(reason)
	await expect(peer.client.client(input(), { signal })).rejects.toBe(reason)
	await expect(collect(peer.client.bidi(input(), { signal }))).rejects.toBe(reason)
	expect(consumed).toBe(0)
})

test('cancels a pending unary call with the caller reason', async (tc) => {
	let started = Promise.withResolvers<void>()
	let cancelled = Promise.withResolvers<void>()
	using peer = await serve({
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

	expect(await failure).toBe(reason)
	await cancelled.promise
})

test('passes the native deadline to grpc-js', async (tc) => {
	using peer = await serve({ unary() {} })

	await expect(
		peer.client.unary(
			{ value: 1 },
			{
				signal: tc.signal,
				deadline: Date.now() + 50,
			}
		)
	).rejects.toMatchObject({ code: status.DEADLINE_EXCEEDED })
})

test('starts a response stream only when iteration begins', async (tc) => {
	let calls = 0
	using peer = await serve({
		server(call) {
			calls++
			call.write({ value: call.request.value })
			call.end()
		},
	})
	let stream = peer.client.server({ value: 7 }, { signal: tc.signal })
	await setTimeout(10, undefined, { signal: tc.signal })
	expect(calls).toBe(0)
	expect(await collect(stream)).toEqual([7])
	expect(calls).toBe(1)
})

test('yields every server response and completes after OK trailers', async (tc) => {
	using peer = await serve({
		server(call) {
			call.write({ value: 1 })
			call.write({ value: 2 })
			call.end()
		},
	})

	expect(await collect(peer.client.server({ value: 0 }, { signal: tc.signal }))).toEqual([1, 2])
})

test('rejects response iteration on non-OK trailers', async (tc) => {
	using peer = await serve({
		server(call) {
			call.emit('error', { code: status.PERMISSION_DENIED, details: 'denied' })
		},
	})

	await expect(
		collect(peer.client.server({ value: 0 }, { signal: tc.signal }))
	).rejects.toMatchObject({
		code: status.PERMISSION_DENIED,
		details: 'denied',
	})
})

test('cancels the RPC when a response consumer breaks early', async (tc) => {
	let cancelled = Promise.withResolvers<void>()
	using peer = await serve({
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
	using peer = await serve({
		server() {
			started.resolve()
		},
	})
	let controller = new AbortController()
	let reason = new Error('stop reading')
	let pending = collect(
		peer.client.server(
			{ value: 0 },
			{ signal: AbortSignal.any([tc.signal, controller.signal]) }
		)
	)
	let failure = pending.catch((error: unknown) => error)
	await started.promise
	controller.abort(reason)

	expect(await failure).toBe(reason)
})

test('half-closes bidirectional input and reads the remaining responses', async (tc) => {
	using peer = await serve({
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

	expect(await collect(peer.client.bidi(messages(1, 2, 3), { signal: tc.signal }))).toEqual([
		1, 2, 3,
	])
})

test('returns a client-streaming response after input ends', async (tc) => {
	using peer = await serve({
		client(call, respond) {
			let sum = 0
			call.on('data', (message: Message) => {
				sum += message.value
			})
			call.on('end', () => respond(null, { value: sum }))
		},
	})

	expect((await peer.client.client(messages(1, 2, 3), { signal: tc.signal })).value).toBe(6)
})

test('propagates a bidirectional producer failure without replacing it with cancellation', async (tc) => {
	let started = Promise.withResolvers<void>()
	let cancelled = Promise.withResolvers<void>()
	let failure = new Error('producer failed')
	using peer = await serve({
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

	await expect(collect(peer.client.bidi(input(), { signal: tc.signal }))).rejects.toBe(failure)
	await cancelled.promise
})

test('propagates a client-streaming producer failure', async (tc) => {
	let failure = new Error('producer failed')
	using peer = await serve({
		client(call) {
			call.resume()
		},
	})
	async function* input() {
		yield { value: 1 }
		throw failure
	}

	await expect(peer.client.client(input(), { signal: tc.signal })).rejects.toBe(failure)
})

test('bounds request production while a peer stops reading', async (tc) => {
	let connected = Promise.withResolvers<() => void>()
	let produced = 0
	let padding = new Uint8Array(128 * 1024)
	using peer = await serve({
		client(call, respond) {
			let received = 0
			call.on('data', () => {
				received++
			})
			call.on('end', () => respond(null, { value: received }))
			call.pause()
			connected.resolve(() => call.resume())
		},
	})
	async function* input() {
		for (let value = 0; value < 256; value++) {
			produced++
			yield { value, padding }
		}
	}
	let response = peer.client.client(input(), { signal: tc.signal })
	let resume = await connected.promise
	try {
		await setTimeout(50, undefined, { signal: tc.signal })
		expect(produced).toBeGreaterThan(0)
		expect(produced).toBeLessThan(256)
	} finally {
		resume()
	}

	expect((await response).value).toBe(256)
})

test('aborts a drain wait and closes the request producer', async (tc) => {
	let connected = Promise.withResolvers<void>()
	let produced = 0
	let closed = false
	let padding = new Uint8Array(128 * 1024)
	using peer = await serve({
		bidi(call) {
			call.pause()
			connected.resolve()
		},
	})
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
	let response = collect(
		peer.client.bidi(input(), { signal: AbortSignal.any([tc.signal, controller.signal]) })
	)
	let failure = response.catch((error: unknown) => error)
	await connected.promise
	await setTimeout(50, undefined, { signal: tc.signal })
	expect(produced).toBeGreaterThan(0)
	expect(produced).toBeLessThan(256)
	controller.abort(reason)
	expect(await failure).toBe(reason)
	expect(closed).toBe(true)
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
	using peer = await serve({
		bidi(call) {
			call.on('data', () => call.end())
		},
	})
	let producer = blockedInput()
	try {
		expect(await collect(peer.client.bidi(producer.input, { signal: tc.signal }))).toEqual([])
		await producer.returned
	} finally {
		producer.release({ done: true, value: undefined })
	}
})

test('stops a client-streaming producer after an early server response', async (tc) => {
	using peer = await serve({
		client(call, respond) {
			call.once('data', () => respond(null, { value: 42 }))
		},
	})
	let producer = blockedInput()
	try {
		expect((await peer.client.client(producer.input, { signal: tc.signal })).value).toBe(42)
		await producer.returned
	} finally {
		producer.release({ done: true, value: undefined })
	}
})

test('cancels while a request next is blocked and never writes its late value', async (tc) => {
	let started = Promise.withResolvers<void>()
	let received: number[] = []
	using peer = await serve({
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
	let response = collect(
		peer.client.bidi(producer.input, {
			signal: AbortSignal.any([tc.signal, controller.signal]),
		})
	)
	let failure = response.catch((error: unknown) => error)
	try {
		await started.promise
		controller.abort(reason)
		expect(await failure).toBe(reason)
		await producer.returned
		producer.release({ done: false, value: { value: 2 } })
		await setTimeout(10, undefined, { signal: tc.signal })
		expect(received).toEqual([1])
	} finally {
		producer.release({ done: true, value: undefined })
	}
})

test('stops requests on abort while the response consumer is paused', async (tc) => {
	using peer = await serve({
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
		expect((await stream.next()).value?.value).toBe(1)
		controller.abort(reason)
		await producer.returned
		producer.release({ done: false, value: { value: 2 } })
		await expect(stream.next()).rejects.toBe(reason)
	} finally {
		producer.release({ done: true, value: undefined })
		await stream.return?.()
	}
})

test('stops requests at server EOF while the response consumer is paused', async (tc) => {
	let end = Promise.withResolvers<() => void>()
	using peer = await serve({
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
		expect((await stream.next()).value?.value).toBe(1)
		let finish = await end.promise
		finish()
		await producer.returned
		producer.release({ done: false, value: { value: 2 } })
		expect((await stream.next()).done).toBe(true)
	} finally {
		producer.release({ done: true, value: undefined })
		await stream.return?.()
	}
})

async function checkBufferedCancellation(bidi: boolean, signal: AbortSignal) {
	let buffered = Promise.withResolvers<void>()
	let received = 0
	let observer: Interceptor = (options, nextCall) =>
		new InterceptingCall(nextCall(options), {
			start(metadata, _listener, next) {
				next(metadata, {
					onReceiveMessage(message, forward) {
						forward(message)
						received += 1
						if (received === 3) {
							buffered.resolve()
						}
					},
				})
			},
		})
	using peer = await serve({
		server(call) {
			for (let value of [1, 2, 3]) {
				call.write({ value })
			}
		},
		bidi(call) {
			call.once('data', () => {
				for (let value of [1, 2, 3]) {
					call.write({ value })
				}
			})
		},
	})
	let controller = new AbortController()
	let options = {
		signal: AbortSignal.any([signal, controller.signal]),
		interceptors: [observer],
	}
	let responses = bidi
		? peer.client.bidi(messages(1), options)
		: peer.client.server({ value: 0 }, options)
	let stream = responses[Symbol.asyncIterator]()
	let reason = new Error('cancel buffered responses')

	try {
		expect((await stream.next()).value?.value).toBe(1)
		await buffered.promise
		controller.abort(reason)
		await expect(stream.next()).rejects.toBe(reason)
	} finally {
		await stream.return?.()
	}
}

test('discards buffered server-stream responses after caller cancellation', async (tc) => {
	expect.assertions(2)
	await checkBufferedCancellation(false, tc.signal)
})

test('discards buffered bidirectional responses after caller cancellation', async (tc) => {
	expect.assertions(2)
	await checkBufferedCancellation(true, tc.signal)
})
