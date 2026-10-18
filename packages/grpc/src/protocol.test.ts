import { once } from 'node:events'
import { constants } from 'node:http2'
import { setTimeout } from 'node:timers/promises'
import { deflateSync, gzipSync } from 'node:zlib'

import { expect, test } from 'vitest'

import { collect, frame, rawServer, reply, requests, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { RpcError, Status } from './error.ts'
import { createServiceClient } from './service.ts'
import type { Metadata, RpcStatus } from './types.ts'

// A controlled HTTP/2 peer can send malformed framing and trailers that a real YDB server cannot produce on demand.

for (let [outcome, status] of [
	['successful', Status.OK],
	['failed', Status.INVALID_ARGUMENT],
] as const) {
	test(`reuses one session after repeated ${outcome} unary calls`, async (tc) => {
		await using peer = await rawServer(async (stream) => {
			await requests(stream)
			reply(
				stream,
				status === Status.OK ? ['response'] : [],
				{},
				{
					'grpc-status': String(status),
					'grpc-message': 'result',
				}
			)
		})
		using transport = new Client(peer.authority)
		let client = createServiceClient(service, transport)

		// Exceed the peer's reset burst limit without replacing its HTTP/2 session.
		await Promise.all(
			Array.from({ length: 16 }, async () => {
				for (let index = 0; index < 100; index++) {
					let response = client.unary('request', { signal: tc.signal }).then(
						(value) => ({ code: Status.OK, value }),
						(error: unknown) => {
							if (!(error instanceof RpcError)) throw error
							return { code: error.code, value: error.details }
						}
					)
					// Each worker keeps one RPC in flight, below the concurrent-stream limit.
					// eslint-disable-next-line no-await-in-loop
					let result = await response
					expect(result).toEqual({
						code: status,
						value: status === Status.OK ? 'response' : 'result',
					})
				}
			})
		)

		expect(peer.sessions).toHaveLength(1)
		expect(peer.streams).toHaveLength(1600)
		expect(peer.errors).toEqual([])
	})
}

test('decodes split frame headers, split payloads and multiple frames in one chunk', async (tc) => {
	await using peer = await rawServer(async (stream) => {
		stream.respond(
			{ ':status': 200, 'content-type': 'application/grpc' },
			{ waitForTrailers: true }
		)
		stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
		let first = frame('first')

		for (let piece of [first.subarray(0, 2), first.subarray(2, 7), first.subarray(7)]) {
			stream.write(piece)
			// Each fragment must reach the receiver before the next one is written.
			// eslint-disable-next-line no-await-in-loop
			await setTimeout(1, undefined, { signal: tc.signal })
		}

		stream.end(Buffer.concat([frame(''), frame('third'), frame('fourth')]))
	})
	using client = new Client(peer.authority)

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual(['first', '', 'third', 'fourth'])
	expect(peer.errors).toEqual([])
})

for (let [name, bytes] of [
	['incomplete frame header', Buffer.from([0, 0, 0])],
	['incomplete frame body', frame('hello').subarray(0, 7)],
	['invalid compression flag', Buffer.from([2, 0, 0, 0, 0])],
] as const) {
	test(`rejects an ${name}`, async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond(
				{ ':status': 200, 'content-type': 'application/grpc' },
				{ waitForTrailers: true }
			)
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
			stream.end(bytes)
		})
		using client = new Client(peer.authority)

		let call = client.call(service.serverStream, '', { signal: tc.signal })
		let responses = collect(call)

		await expect(responses).rejects.toMatchObject({
			code: Status.INTERNAL,
		})
	})
}

for (let [encoding, compress] of [
	['gzip', gzipSync],
	['deflate', deflateSync],
] as const) {
	test(`decodes ${encoding} responses and uncompressed frames in the same stream`, async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond(
				{ ':status': 200, 'content-type': 'application/grpc', 'grpc-encoding': encoding },
				{ waitForTrailers: true }
			)
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
			stream.end(Buffer.concat([frame(compress('compressed'), true), frame('identity')]))
		})
		using client = new Client(peer.authority)

		let call = client.call(service.serverStream, '', { signal: tc.signal })
		let responses = await collect(call)

		expect(responses).toEqual(['compressed', 'identity'])
	})

	test(`enforces the receive limit after ${encoding} decompression`, async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond(
				{ ':status': 200, 'content-type': 'application/grpc', 'grpc-encoding': encoding },
				{ waitForTrailers: true }
			)
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
			stream.end(frame(compress(Buffer.alloc(4096)), true))
		})
		using client = new Client(peer.authority, { maxReceiveBytes: 64 })

		let call = client.call(service.serverStream, '', { signal: tc.signal })
		let responses = collect(call)

		await expect(responses).rejects.toMatchObject({
			code: Status.RESOURCE_EXHAUSTED,
		})
	})
}

test('accepts an identity response encoding', async (tc) => {
	await using peer = await rawServer((stream) =>
		reply(stream, ['value'], { 'grpc-encoding': 'identity' })
	)
	using client = new Client(peer.authority)

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual(['value'])
})

test('rejects an unsupported compressed response encoding', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({
			':status': 200,
			'content-type': 'application/grpc',
			'grpc-encoding': 'snappy',
		})
		stream.end(frame('not snappy', true))
	})
	using client = new Client(peer.authority)

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toMatchObject({
		code: Status.UNIMPLEMENTED,
	})
})

test('rejects compressed framing without a declared encoding', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.end(frame(gzipSync('value'), true))
	})
	using client = new Client(peer.authority)

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toMatchObject({
		code: Status.INTERNAL,
	})
})

test('rejects an oversized advertised frame before waiting for its body', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		let header = Buffer.alloc(5)
		header.writeUInt32BE(1024 * 1024, 1)
		stream.write(header)
	})
	using client = new Client(peer.authority, { maxReceiveBytes: 32 })

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toMatchObject({
		code: Status.RESOURCE_EXHAUSTED,
	})
})

test('allows a receive payload exactly at its configured limit', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['x'.repeat(32)]))
	using client = new Client(peer.authority, { maxReceiveBytes: 32 })

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual(['x'.repeat(32)])
})

test('rejects an oversized outgoing message', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, []))
	using client = new Client(peer.authority, { maxSendBytes: 4 })

	let call = client.call(service.unary, 'large', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toMatchObject({
		code: Status.RESOURCE_EXHAUSTED,
	})
})

test('reports trailers-only status and decodes percent-escaped details', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond(
			{
				':status': 200,
				'content-type': 'application/grpc',
				'grpc-status': '7',
				'grpc-message': encodeURIComponent('access denied: тест %'),
				'x-detail-bin': Buffer.from([0, 255]).toString('base64'),
			},
			{ endStream: true }
		)
	})
	using client = new Client(peer.authority)
	let statuses: RpcStatus[] = []
	let trailers: Metadata[] = []
	let failure = await collect(
		client.call(service.unary, '', {
			signal: tc.signal,
			onStatus: (status) => statuses.push(status),
			onTrailer: (metadata) => trailers.push(metadata),
		})
	).catch((error: unknown) => error)

	expect(failure).toMatchObject({
		code: Status.PERMISSION_DENIED,
		details: 'access denied: тест %',
	})
	expect(statuses).toHaveLength(1)
	expect(statuses[0]?.code).toBe(Status.PERMISSION_DENIED)
	expect(trailers).toHaveLength(1)
	expect([...(trailers[0]!['x-detail-bin'] as Uint8Array)]).toEqual([0, 255])
})

test('accepts trailers-only successful completion of an empty response stream', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond(
			{ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' },
			{ endStream: true }
		)
	})
	using client = new Client(peer.authority)

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual([])
})

test('rejects missing gRPC status instead of inferring success from HTTP 200', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.end(frame('unconfirmed'))
	})
	using client = new Client(peer.authority)

	let call = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toMatchObject({
		code: Status.UNKNOWN,
	})
})

for (let value of ['oops', '0suffix', '-1', '17']) {
	test(`rejects malformed gRPC status ${value}`, async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond(
				{ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': value },
				{ endStream: true }
			)
		})
		using client = new Client(peer.authority)

		let call = client.call(service.unary, '', { signal: tc.signal })
		let responses = collect(call)

		await expect(responses).rejects.toMatchObject({
			code: Status.INTERNAL,
		})
	})
}

for (let [httpStatus, grpcStatus] of [
	[400, Status.INTERNAL],
	[401, Status.UNAUTHENTICATED],
	[403, Status.PERMISSION_DENIED],
	[404, Status.UNIMPLEMENTED],
	[429, Status.UNAVAILABLE],
	[502, Status.UNAVAILABLE],
	[503, Status.UNAVAILABLE],
	[504, Status.UNAVAILABLE],
	[500, Status.UNKNOWN],
]) {
	test(`maps HTTP ${httpStatus} without gRPC status to code ${grpcStatus}`, async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond({ ':status': httpStatus! }, { endStream: true })
		})
		using client = new Client(peer.authority)

		let call = client.call(service.unary, '', { signal: tc.signal })
		let responses = collect(call)

		await expect(responses).rejects.toMatchObject({
			code: grpcStatus,
		})
	})
}

test('rejects a non-gRPC response content type', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'text/html', 'grpc-status': '0' })
		stream.end(frame('not a grpc server'))
	})
	using client = new Client(peer.authority)

	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toBeInstanceOf(Error)
})

test('preserves repeated binary metadata independently in headers and trailers', async (tc) => {
	await using peer = await rawServer((stream) =>
		reply(
			stream,
			['value'],
			{ 'x-tags-bin': 'AQI=, /w==' },
			{ 'grpc-status': '0', 'x-tags-bin': ['Aw==', 'BA=='] }
		)
	)
	using client = new Client(peer.authority)
	let headers: Metadata | undefined
	let trailers: Metadata | undefined

	await collect(
		client.call(service.unary, '', {
			signal: tc.signal,
			onHeader: (metadata) => {
				headers = metadata
			},
			onTrailer: (metadata) => {
				trailers = metadata
			},
		})
	)

	expect((headers!['x-tags-bin'] as Uint8Array[]).map((bytes) => Array.from(bytes))).toEqual([
		[1, 2],
		[255],
	])
	expect((trailers!['x-tags-bin'] as Uint8Array[]).map((bytes) => Array.from(bytes))).toEqual([
		[3],
		[4],
	])
})

test('sends a remaining deadline as gRPC timeout metadata', async (tc) => {
	let timeout = ''
	await using peer = await rawServer((stream, headers) => {
		timeout = String(headers['grpc-timeout'])
		reply(stream, ['value'])
	})
	using client = new Client(peer.authority)

	await collect(
		client.call(service.unary, '', {
			signal: tc.signal,
			deadline: new Date(Date.now() + 10_000),
		})
	)

	expect(timeout).toMatch(/^\d{1,8}[HMSmun]$/)
	expect(Number.parseInt(timeout)).toBeGreaterThan(0)
})

test('rejects an elapsed deadline without opening an RPC', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['unexpected']))
	using client = new Client(peer.authority)

	let call = client.call(service.unary, '', { signal: tc.signal, deadline: Date.now() - 1 })
	let responses = collect(call)

	await expect(responses).rejects.toMatchObject({
		code: Status.DEADLINE_EXCEEDED,
	})
	expect(peer.streams).toHaveLength(0)
})

for (let bidi of [false, true]) {
	test(`discards buffered ${bidi ? 'bidirectional' : 'server-stream'} responses after caller cancellation`, async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
			stream.write(Buffer.concat([frame('first'), frame('second'), frame('third')]))
		})
		using client = new Client(peer.authority)
		let controller = new AbortController()
		let reason = new Error('cancel buffered responses')
		let statuses: RpcStatus[] = []
		async function* input() {
			yield ''
		}
		let stream = client.call(bidi ? service.bidi : service.serverStream, bidi ? input() : '', {
			signal: AbortSignal.any([tc.signal, controller.signal]),
			onStatus: (status) => statuses.push(status),
		})
		let responses = stream[Symbol.asyncIterator]()

		expect((await responses.next()).value).toBe('first')
		controller.abort(reason)
		await expect(responses.next()).rejects.toBe(reason)
		expect(statuses).toHaveLength(1)
		expect(statuses[0]?.code).toBe(Status.CANCELLED)
	})
}

test('reports status once when an error is followed by transport close', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.close(constants.NGHTTP2_INTERNAL_ERROR)
	})
	using client = new Client(peer.authority)
	let statuses: RpcStatus[] = []

	let call = client.call(service.unary, '', {
		signal: tc.signal,
		onStatus: (status) => statuses.push(status),
	})
	let responses = collect(call)

	await expect(responses).rejects.toBeInstanceOf(Error)
	await setTimeout(5, undefined, { signal: tc.signal })
	expect(statuses).toHaveLength(1)
})

test('rejects a unary call that receives no message', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, []))
	using client = new Client(peer.authority)
	let api = createServiceClient(service, client)

	await expect(api.unary('', { signal: tc.signal })).rejects.toMatchObject({
		code: Status.INTERNAL,
	})
})

test('rejects a unary call that receives multiple messages', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['first', 'second']))
	using client = new Client(peer.authority)
	let api = createServiceClient(service, client)

	await expect(api.unary('', { signal: tc.signal })).rejects.toMatchObject({
		code: Status.INTERNAL,
	})
})

for (let hook of ['onHeader', 'onTrailer'] as const) {
	test(`rejects the call when ${hook} throws`, async (tc) => {
		await using peer = await rawServer((stream) => reply(stream, ['value']))
		using client = new Client(peer.authority)
		let failure = new Error('observer failed')

		let call = client.call(service.unary, '', {
			signal: tc.signal,
			[hook]() {
				throw failure
			},
		})
		let responses = collect(call)

		await expect(responses).rejects.toBe(failure)
	})
}

test('preserves the RPC outcome when its terminal status observer throws', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['value']))
	using client = new Client(peer.authority)

	let call = client.call(service.unary, '', {
		signal: tc.signal,
		onStatus() {
			throw new Error('observer failed')
		},
	})
	let responses = await collect(call)

	expect(responses).toEqual(['value'])
})

for (let [name, metadata] of [
	['pseudo-header', { ':path': '/unrelated' }],
	['non-ASCII text', { 'x-text': 'текст' }],
	['bytes without binary suffix', { 'x-data': new Uint8Array([1]) }],
	['text with binary suffix', { 'x-data-bin': 'not bytes' }],
] as [string, Metadata][]) {
	test(`rejects invalid outgoing metadata: ${name}`, async (tc) => {
		await using peer = await rawServer((stream) => reply(stream, ['unexpected']))
		using client = new Client(peer.authority)

		let call = client.call(service.unary, '', { signal: tc.signal, metadata })
		let responses = collect(call)

		await expect(responses).rejects.toBeInstanceOf(TypeError)
		expect(peer.streams).toHaveLength(0)
	})
}

test('bounds response production while the consumer is paused', async (tc) => {
	let produced = 0
	let payload = frame('x'.repeat(256 * 1024))
	await using peer = await rawServer(async (stream) => {
		let stopped = new AbortController()
		stream.on('close', () => stopped.abort())
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })

		try {
			for (let index = 0; index < 256; index++) {
				produced++
				if (!stream.write(payload)) {
					// The peer follows HTTP/2 backpressure instead of queuing the whole data set.
					// eslint-disable-next-line no-await-in-loop
					await once(stream, 'drain', {
						signal: AbortSignal.any([tc.signal, stopped.signal]),
					})
				}
			}
		} catch (error) {
			if (!stopped.signal.aborted) {
				throw error
			}
		}
	})
	using client = new Client(peer.authority)
	let stream = client.call(service.serverStream, '', { signal: tc.signal })
	let responses = stream[Symbol.asyncIterator]()

	try {
		expect((await responses.next()).value?.length).toBe(256 * 1024)
		await setTimeout(50, undefined, { signal: tc.signal })
		expect(produced).toBeGreaterThan(0)
		expect(produced).toBeLessThan(256)
	} finally {
		await responses.return?.()
	}
})

test('reports cancellation once when the response consumer returns early', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.write(frame('value'))
	})
	using client = new Client(peer.authority)
	let statuses: RpcStatus[] = []

	for await (let response of client.call(service.serverStream, '', {
		signal: tc.signal,
		onStatus: (status) => statuses.push(status),
	})) {
		expect(response).toBe('value')
		break
	}

	expect(statuses).toHaveLength(1)
	expect(statuses[0]?.code).toBe(Status.CANCELLED)
})

test('accepts a numeric gRPC status with leading zeroes', async (tc) => {
	await using peer = await rawServer((stream) =>
		reply(stream, ['value'], {}, { 'grpc-status': '00' })
	)
	using client = new Client(peer.authority)

	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual(['value'])
})

test('caller cancellation still wins over buffered responses after OK trailers', async (tc) => {
	let trailers = Promise.withResolvers<Metadata>()
	await using peer = await rawServer((stream) => reply(stream, ['first', 'second']))
	using client = new Client(peer.authority)
	let controller = new AbortController()
	let reason = new Error('stop after trailers')
	let response = client.call(service.serverStream, '', {
		signal: AbortSignal.any([tc.signal, controller.signal]),
		onTrailer: trailers.resolve,
	})
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	await trailers.promise
	controller.abort(reason)
	await expect(iterator.next()).rejects.toBe(reason)
})

test('drains buffered responses before reporting non-OK server trailers', async (tc) => {
	let sendTail = Promise.withResolvers<() => void>()
	let trailers = Promise.withResolvers<Metadata>()
	await using peer = await rawServer((stream) => {
		stream.respond(
			{ ':status': 200, 'content-type': 'application/grpc' },
			{ waitForTrailers: true }
		)
		stream.on('wantTrailers', () =>
			stream.sendTrailers({ 'grpc-status': '13', 'grpc-message': 'server failed' })
		)
		stream.write(frame('first'))
		sendTail.resolve(() => stream.end(frame('second')))
	})
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', {
		signal: tc.signal,
		onTrailer: trailers.resolve,
	})
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	let finish = await sendTail.promise
	finish()
	await trailers.promise
	expect((await iterator.next()).value).toBe('second')
	await expect(iterator.next()).rejects.toMatchObject({
		code: Status.INTERNAL,
		details: 'server failed',
	})
})

test('keeps accepted responses after the RPC deadline passes following terminal trailers', async (tc) => {
	let trailers = Promise.withResolvers<Metadata>()
	await using peer = await rawServer((stream) => reply(stream, ['first', 'second']))
	using client = new Client(peer.authority)
	let deadline = Date.now() + 80
	let response = client.call(service.serverStream, '', {
		signal: tc.signal,
		deadline,
		onTrailer: trailers.resolve,
	})
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	await trailers.promise
	await setTimeout(Math.max(0, deadline - Date.now()) + 10, undefined, { signal: tc.signal })
	expect((await iterator.next()).value).toBe('second')
	expect((await iterator.next()).done).toBe(true)
})

test('closing the client discards buffered responses after terminal trailers', async (tc) => {
	let trailers = Promise.withResolvers<Metadata>()
	await using peer = await rawServer((stream) => reply(stream, ['first', 'second']))
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', {
		signal: tc.signal,
		onTrailer: trailers.resolve,
	})
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	await trailers.promise
	client.close()
	await expect(iterator.next()).rejects.toMatchObject({ code: Status.CANCELLED })
})
