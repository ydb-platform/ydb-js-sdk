import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import { expect, test } from 'vitest'

import { Client, MessageSizeError, ProtocolError, Status } from '@ydbjs/grpc'

import { collect, frame, rawServer, reply, service } from '../../grpc/tests/fixtures.ts'
import { retry } from './index.ts'

// Bun 1.4.3 can end the response before stream.close() sends its reset (oven-sh/bun#33380).
// Use a Node peer to exercise the client's transport-reset handling.
async function overloadResetPeer(signal: AbortSignal) {
	let peerProcess = spawn(
		'node',
		[
			'--eval',
			`
			let { createServer, constants } = require('node:http2')
			let server = createServer()
			let calls = 0
			server.on('session', session => session.on('error', () => {}))
			server.on('stream', stream => {
				let attempt = ++calls
				stream.on('error', () => {})
				stream.once('end', () => {
					if (attempt === 1) {
						stream.close(constants.NGHTTP2_ENHANCE_YOUR_CALM)
						return
					}
					stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
					stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
					stream.end(Buffer.from([0, 0, 0, 0, 2, 111, 107]))
				})
				stream.resume()
			})
			server.listen(0, '127.0.0.1', () => process.send(server.address().port))
			`,
		],
		{ stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
	)
	try {
		let [port] = await once(peerProcess, 'message', { signal })
		return {
			authority: `http://127.0.0.1:${port}`,
			async [Symbol.asyncDispose]() {
				if (peerProcess.exitCode !== null || peerProcess.signalCode !== null) return
				let exited = once(peerProcess, 'exit')
				peerProcess.kill()
				await exited
			},
		}
	} catch (error) {
		peerProcess.kill()
		throw error
	}
}

for (let idempotent of [false, true]) {
	for (let direction of ['request', 'response', 'compressed response'] as const) {
		test(`does not retry an oversized ${direction} with idempotent=${idempotent}`, async (tc) => {
			await using peer = await rawServer((stream) => {
				stream.resume()
				if (direction === 'compressed response') {
					stream.respond({
						':status': 200,
						'content-type': 'application/grpc',
						'grpc-encoding': 'gzip',
					})
					stream.end(frame(gzipSync(Buffer.alloc(256)), true))
				} else if (direction === 'response') {
					reply(stream, ['x'.repeat(33)])
				}
			})
			using client = new Client(peer.authority, { maxSendBytes: 32, maxReceiveBytes: 32 })
			let attempts = 0
			let request = direction === 'request' ? 'x'.repeat(33) : ''
			let result = retry(
				{ idempotent, signal: tc.signal, budget: 3, strategy: 0 },
				(signal) => {
					attempts++
					return collect(client.call(service.serverStream, request, { signal }))
				}
			)

			await expect(result).rejects.toBeInstanceOf(MessageSizeError)
			expect(attempts).toBe(1)
		})
	}

	for (let failure of ['request serialization', 'response deserialization', 'framing'] as const) {
		test(`does not retry ${failure} with idempotent=${idempotent}`, async (tc) => {
			let cause = new Error('codec rejected the value')
			await using peer = await rawServer((stream) => {
				stream.resume()
				if (failure === 'framing') {
					stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
					stream.end(Buffer.from([2, 0, 0, 0, 0]))
				} else if (failure === 'response deserialization') {
					reply(stream, ['value'])
				}
			})
			using client = new Client(peer.authority)
			let method = {
				...service.serverStream,
				...(failure === 'request serialization' && {
					requestSerialize() {
						throw cause
					},
				}),
				...(failure === 'response deserialization' && {
					responseDeserialize() {
						throw cause
					},
				}),
			}
			let attempts = 0
			let result = retry(
				{ idempotent, signal: tc.signal, budget: 3, strategy: 0 },
				(signal) => {
					attempts++
					return collect(client.call(method, '', { signal }))
				}
			)

			let error = await result.catch((caught: unknown) => caught)
			expect(error).toBeInstanceOf(ProtocolError)
			expect((error as Error).cause).toBe(failure === 'framing' ? undefined : cause)
			expect(attempts).toBe(1)
		})
	}

	test(`retries server admission overload with idempotent=${idempotent}`, async (tc) => {
		let calls = 0
		await using peer = await rawServer((stream) => {
			stream.resume()
			calls++
			reply(
				stream,
				calls === 1 ? [] : ['ok'],
				{},
				{
					'grpc-status': String(calls === 1 ? Status.RESOURCE_EXHAUSTED : Status.OK),
				}
			)
		})
		using client = new Client(peer.authority)

		let result = retry({ idempotent, signal: tc.signal, budget: 3, strategy: 0 }, (signal) =>
			collect(client.call(service.serverStream, '', { signal }))
		)

		await expect(result).resolves.toEqual(['ok'])
		expect(calls).toBe(2)
	})

	test(`retries server INTERNAL only when idempotent=${idempotent}`, async (tc) => {
		let calls = 0
		await using peer = await rawServer((stream) => {
			stream.resume()
			calls++
			reply(
				stream,
				calls === 1 ? [] : ['ok'],
				{},
				{
					'grpc-status': String(calls === 1 ? Status.INTERNAL : Status.OK),
				}
			)
		})
		using client = new Client(peer.authority)

		let result = retry({ idempotent, signal: tc.signal, budget: 3, strategy: 0 }, (signal) =>
			collect(client.call(service.serverStream, '', { signal }))
		)

		let outcome = await result.catch((error: unknown) => error)
		expect(outcome).toMatchObject(
			idempotent ? ['ok'] : { name: 'RpcError', code: Status.INTERNAL }
		)
		expect(calls).toBe(idempotent ? 2 : 1)
	})

	test(`retries a transport overload reset only when idempotent=${idempotent}`, async (tc) => {
		let calls = 0
		await using peer = await overloadResetPeer(tc.signal)
		using client = new Client(peer.authority)

		let result = retry({ idempotent, signal: tc.signal, budget: 3, strategy: 0 }, (signal) => {
			calls++
			return collect(client.call(service.serverStream, '', { signal }))
		})

		let outcome = await result.catch((error: unknown) => error)
		expect(outcome).toMatchObject(
			idempotent ? ['ok'] : { name: 'TransportError', code: Status.RESOURCE_EXHAUSTED }
		)
		expect(calls).toBe(idempotent ? 2 : 1)
	})
}
