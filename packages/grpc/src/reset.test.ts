import { type ServerHttp2Stream, constants, createServer } from 'node:http2'
import { setImmediate } from 'node:timers/promises'

import { abortable } from '@ydbjs/abortable'
import { expect, test, vi } from 'vitest'

import { collect, deferred, frame, rawServer, reply, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { Status } from './error.ts'

// A raw server controls flow windows and reset ordering independently of SDK server behavior.

test('receives concurrent response headers while a large request is blocked by flow control', async (tc) => {
	let send = deferred()
	let serialized = deferred()
	let largeStarted = deferred()
	let smallStarted = deferred<ServerHttp2Stream>()
	let server = createServer({ settings: { initialWindowSize: 0 } })
	await using peer = await rawServer((stream, headers) => {
		if (headers[':path'] === '/test.Transport/Large') {
			largeStarted.resolve()
		} else {
			smallStarted.resolve(stream)
		}
	}, server)
	let payload = new Uint8Array(16 * 1024 * 1024)
	using client = new Client(peer.authority)
	let controller = new AbortController()
	let reason = new Error('stop blocked request')
	async function* input() {
		await send.promise
		yield payload
	}
	let method = {
		...service.bidi,
		path: '/test.Transport/Large',
		requestDeserialize: (bytes: Uint8Array) => bytes,
		requestSerialize(value: Uint8Array) {
			serialized.resolve()
			return value
		},
	}
	let call = client.call(method, input(), {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let blocked = collect(call).catch((error: unknown) => error)
	await abortable(tc.signal, largeStarted.promise)
	let response = collect(client.call(service.unary, '', { signal: tc.signal }))
	let small = await abortable(tc.signal, smallStarted.promise)

	send.resolve()
	await abortable(tc.signal, serialized.promise)
	reply(small, ['concurrent response'])

	await expect(response).resolves.toEqual(['concurrent response'])
	expect(peer.sessions).toHaveLength(1)
	controller.abort(reason)
	expect(await blocked).toBe(reason)
	expect(peer.errors).toEqual([])
})

for (let [name, reset, status] of [
	['refused stream', constants.NGHTTP2_REFUSED_STREAM, Status.UNAVAILABLE],
	['cancellation', constants.NGHTTP2_CANCEL, Status.CANCELLED],
	['resource exhaustion', constants.NGHTTP2_ENHANCE_YOUR_CALM, Status.RESOURCE_EXHAUSTED],
	['inadequate security', constants.NGHTTP2_INADEQUATE_SECURITY, Status.PERMISSION_DENIED],
	['protocol error', constants.NGHTTP2_PROTOCOL_ERROR, Status.INTERNAL],
	['flow control error', constants.NGHTTP2_FLOW_CONTROL_ERROR, Status.INTERNAL],
	['internal error', constants.NGHTTP2_INTERNAL_ERROR, Status.INTERNAL],
] as const) {
	for (let streaming of [false, true]) {
		// Bun sends END_STREAM instead of a server reset: https://github.com/oven-sh/bun/pull/33380
		test.skipIf(Boolean(process.versions.bun))(
			`maps HTTP/2 ${name} after ${streaming ? 'streaming' : 'unary'} requests`,
			async (tc) => {
				let attemptedResets: number[] = []
				let resetSent = deferred<number>()
				await using peer = await rawServer((stream) => {
					let resetRequest = () => {
						attemptedResets.push(reset)
						stream.once('close', () => resetSent.resolve(stream.rstCode))
						stream.close(reset)
					}
					if (streaming) {
						stream.once('data', resetRequest)
					} else {
						stream.once('end', resetRequest)
						stream.resume()
					}
				})
				using client = new Client(peer.authority)
				let release = deferred()
				async function* input() {
					yield 'request'
					await release.promise
				}
				let statuses: number[] = []
				try {
					let method = streaming ? service.bidi : service.unary
					let request = streaming ? input() : 'request'
					let call = client.call(method, request, {
						signal: tc.signal,
						onStatus: (result) => statuses.push(result.code),
					})
					let responses = collect(call)

					await expect(responses).rejects.toMatchObject({ code: status })
					expect(statuses).toEqual([status])
					let sentCode = await abortable(tc.signal, resetSent.promise)
					expect(sentCode).toBe(reset)
					expect(attemptedResets).toEqual([reset])
				} finally {
					release.resolve()
				}
			}
		)
	}
}

for (let status of [Status.OK, Status.PERMISSION_DENIED]) {
	for (let code of [
		constants.NGHTTP2_NO_ERROR,
		constants.NGHTTP2_CANCEL,
		constants.NGHTTP2_INTERNAL_ERROR,
	]) {
		test(`drains buffered responses with status ${status} after HTTP/2 reset ${code}`, async (tc) => {
			let trailers = deferred()
			let producerWaiting = deferred()
			let release = deferred()
			let opened = deferred<ServerHttp2Stream>()
			await using peer = await rawServer((stream) => {
				stream.resume()
				stream.respond(
					{ ':status': 200, 'content-type': 'application/grpc' },
					{ waitForTrailers: true }
				)
				stream.once('wantTrailers', () =>
					stream.sendTrailers({ 'grpc-status': String(status) })
				)
				stream.write(frame('first'))
				opened.resolve(stream)
			})
			using client = new Client(peer.authority)
			async function* input() {
				yield 'request'
				producerWaiting.resolve()
				await release.promise
			}
			let statuses: number[] = []
			let response = client.call(service.bidi, input(), {
				signal: tc.signal,
				onTrailer: () => trailers.resolve(),
				onStatus: (result) => statuses.push(result.code),
			})
			let responses = response[Symbol.asyncIterator]()
			try {
				let first = await responses.next()
				expect(first.value).toBe('first')
				await abortable(tc.signal, producerWaiting.promise)
				let stream = await abortable(tc.signal, opened.promise)
				let session = stream.session!
				stream.end(Buffer.concat([frame('second'), frame('last')]))
				await abortable(tc.signal, trailers.promise)

				expect(stream.closed).toBe(false)
				expect(stream.destroyed).toBe(false)
				expect(stream.readableEnded).toBe(false)
				let closed = deferred<number>()
				stream.once('close', () => closed.resolve(stream.rstCode))
				stream.close(code)
				let sentCode = await abortable(tc.signal, closed.promise)
				expect(sentCode).toBe(code)

				let pinged = deferred()
				session.ping((error) => (error ? pinged.reject(error) : pinged.resolve()))
				await abortable(tc.signal, pinged.promise)
				await setImmediate(undefined, { signal: tc.signal })

				let second = await responses.next()
				let last = await responses.next()
				expect(second.value).toBe('second')
				expect(last.value).toBe('last')
				let terminal = await responses.next().then(
					(result) => ({ done: result.done, code: Status.OK }),
					(error) => ({ done: true, code: error.code })
				)
				expect(terminal).toEqual({ done: true, code: status })
				expect(statuses).toEqual([status])
			} finally {
				release.resolve()
			}
		})
	}
}

test('drains complete responses before reporting missing status after a normal HTTP/2 close', async (tc) => {
	let closed = deferred()
	await using peer = await rawServer((stream) => {
		stream.once('close', () => closed.resolve())
		stream.once('end', () => {
			stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
			stream.end(Buffer.concat([frame('first'), frame('second')]))
		})
		stream.resume()
	})
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', { signal: tc.signal })
	let iterator = response[Symbol.asyncIterator]()

	let first = await iterator.next()
	expect(first.value).toBe('first')
	await abortable(tc.signal, closed.promise)
	let pinged = deferred()
	peer.sessions[0]!.ping((error) => (error ? pinged.reject(error) : pinged.resolve()))
	await abortable(tc.signal, pinged.promise)
	await setImmediate(undefined, { signal: tc.signal })

	let second = await iterator.next()
	expect(second.value).toBe('second')
	await expect(iterator.next()).rejects.toMatchObject({
		code: Status.UNKNOWN,
		details: 'RPC ended without grpc-status',
	})
})

for (let [name, expired] of [
	['reports deadline expiry when a peer CANCEL arrives before the local timer runs', true],
	['preserves peer cancellation while the absolute deadline is still pending', false],
] as const) {
	// Bun sends END_STREAM instead of a server reset: https://github.com/oven-sh/bun/pull/33380
	test.skipIf(Boolean(process.versions.bun))(`${name}`, async (tc) => {
		let attemptedResets: number[] = []
		let resetSent = deferred<number>()
		await using peer = await rawServer((stream) => {
			stream.once('end', () => {
				attemptedResets.push(constants.NGHTTP2_CANCEL)
				stream.once('close', () => resetSent.resolve(stream.rstCode))
				stream.close(constants.NGHTTP2_CANCEL)
			})
			stream.resume()
		})
		using client = new Client(peer.authority)
		using clock = vi.spyOn(Date, 'now')
		let deadline = Date.now() + 60_000
		let statuses: number[] = []
		let expected = expired ? Status.DEADLINE_EXCEEDED : Status.CANCELLED
		let method = {
			...service.unary,
			requestSerialize(value: string) {
				// Serialization follows deadline setup; changing the clock does not run its timer.
				clock.mockReturnValue(expired ? deadline + 1 : deadline - 1)
				return Buffer.from(value)
			},
		}
		let call = client.call(method, 'request', {
			signal: tc.signal,
			deadline,
			onStatus: (status) => statuses.push(status.code),
		})
		let response = collect(call)

		await expect(response).rejects.toMatchObject({ code: expected })
		expect(statuses).toEqual([expected])
		let sentCode = await abortable(tc.signal, resetSent.promise)
		expect(sentCode).toBe(constants.NGHTTP2_CANCEL)
		expect(attemptedResets).toEqual([constants.NGHTTP2_CANCEL])
	})
}
