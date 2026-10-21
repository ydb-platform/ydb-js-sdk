import { abortable } from '@ydbjs/abortable'
import { expect, test } from 'vitest'

import { deferred, frame, rawServer, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { Status } from './error.ts'

// Protocol faults after accepted data require a controlled peer; YDB cannot schedule them deterministically.
for (let [name, fault, details] of [
	['malformed next frame', 'malformed', 'Invalid gRPC compression flag'],
	['truncated next frame', 'truncated', 'Truncated gRPC message'],
] as const) {
	test(`preserves the current response batch before a ${name}`, async (tc) => {
		let terminal = deferred()
		await using peer = await rawServer((stream) => {
			stream.respond(
				{ ':status': 200, 'content-type': 'application/grpc' },
				{ waitForTrailers: true }
			)
			stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
			stream.write(Buffer.concat([frame('first'), frame('second')]))
		})
		using client = new Client(peer.authority)
		let response = client.call(service.serverStream, '', {
			signal: tc.signal,
			onStatus: () => terminal.resolve(),
		})
		let iterator = response[Symbol.asyncIterator]()

		expect((await iterator.next()).value).toBe('first')
		let tail =
			fault === 'malformed' ? Buffer.from([2, 0, 0, 0, 0]) : frame('truncated').subarray(0, 7)
		peer.streams[0]!.end(tail)
		let ping = new Promise<void>((resolve, reject) => {
			peer.sessions[0]!.ping((error) => (error ? reject(error) : resolve()))
		})
		await abortable(tc.signal, ping)
		if (fault === 'truncated') {
			await abortable(tc.signal, terminal.promise)
		}
		expect((await iterator.next()).value).toBe('second')
		await expect(iterator.next()).rejects.toMatchObject({ code: Status.INTERNAL, details })
	})
}

test('preserves the decompression error and cause after accepted responses', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond(
			{ ':status': 200, 'content-type': 'application/grpc', 'grpc-encoding': 'gzip' },
			{ waitForTrailers: true }
		)
		stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
		stream.write(Buffer.concat([frame('first'), frame('second')]))
	})
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', { signal: tc.signal })
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	peer.streams[0]!.end(frame('invalid gzip', true))
	let ping = new Promise<void>((resolve, reject) => {
		peer.sessions[0]!.ping((error) => (error ? reject(error) : resolve()))
	})
	await abortable(tc.signal, ping)
	expect((await iterator.next()).value).toBe('second')
	await expect(iterator.next()).rejects.toMatchObject({
		code: Status.INTERNAL,
		details: 'Failed to decompress gRPC message',
		cause: { code: 'Z_DATA_ERROR' },
	})
})

test('cancels a read while the frame body is incomplete', async (tc) => {
	let firstSent = deferred()
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		stream.write(frame('incomplete body').subarray(0, 6), () => firstSent.resolve())
	})
	using client = new Client(peer.authority)
	let controller = new AbortController()
	let reason = new Error('cancel partial response')
	let response = client.call(service.serverStream, '', {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let iterator = response[Symbol.asyncIterator]()
	let pending = iterator.next()
	let failure = pending.catch((error: unknown) => error)
	await abortable(tc.signal, firstSent.promise)
	let ping = new Promise<void>((resolve, reject) => {
		peer.sessions[0]!.ping((error) => (error ? reject(error) : resolve()))
	})
	await abortable(tc.signal, ping)

	controller.abort(reason)

	expect(await failure).toBe(reason)
})

// Bun's server session.destroy() delivers clean EOF (rstCode=0), not a transport reset.
test.skipIf(Boolean(process.versions.bun))(
	'settles a pending response read when the HTTP/2 session closes prematurely',
	async (tc) => {
		await using peer = await rawServer((stream) => {
			stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
			stream.write(frame('first'))
		})
		using client = new Client(peer.authority)
		let response = client.call(service.serverStream, '', { signal: tc.signal })
		let iterator = response[Symbol.asyncIterator]()
		expect((await iterator.next()).value).toBe('first')
		let pending = iterator.next()
		let failure = pending.catch((error: unknown) => error)

		peer.sessions[0]!.destroy()

		expect(await failure).toMatchObject({ code: Status.UNAVAILABLE })
	}
)
