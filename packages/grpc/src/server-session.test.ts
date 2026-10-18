import { once } from 'node:events'
import { type ClientHttp2Stream, type IncomingHttpHeaders, connect } from 'node:http2'

import { expect, test } from 'vitest'

import { frame, service } from '../tests/fixtures.ts'
import { Status } from './error.ts'
import { Server } from './server.ts'

// Withheld flow credit reproduces queue pressure without depending on network speed.
test('accepts other RPCs while a large response waits for HTTP/2 flow credit', async (tc) => {
	using server = new Server()
	let large = 'x'.repeat(12 * 1024 * 1024)
	let calls: string[] = []
	server.add(service, {
		unary(value) {
			calls.push(value)
			return value === 'large' ? large : `response:${value}`
		},
	})
	let port = await server.listen()
	let session = connect(`http://127.0.0.1:${port}`, { settings: { initialWindowSize: 0 } })
	let responses: {
		stream: ClientHttp2Stream
		chunks: Buffer[]
		headers: IncomingHttpHeaders
	}[] = []
	try {
		for (let value of ['large', 'second', 'third']) {
			let stream = session.request(
				{
					':method': 'POST',
					':path': service.unary.path,
					'content-type': 'application/grpc',
				},
				{ signal: tc.signal }
			)
			let chunks: Buffer[] = []
			let headers: IncomingHttpHeaders = {}
			stream.on('data', (chunk: Buffer) => chunks.push(chunk))
			stream.on('trailers', (trailers) => Object.assign(headers, trailers))
			let accepted = once(stream, 'response', { signal: tc.signal })
			stream.end(frame(value))
			// oxlint-disable-next-line no-await-in-loop
			await accepted
			responses.push({ stream, chunks, headers })
		}

		expect(calls).toEqual(['large', 'second', 'third'])
		expect(responses.map((response) => response.chunks.length)).toEqual([0, 0, 0])
		let completed = Promise.all(
			responses.map(({ stream }) => once(stream, 'end', { signal: tc.signal }))
		)

		session.settings({ initialWindowSize: 16 * 1024 * 1024 })
		await completed

		for (let [index, expected] of [large, 'response:second', 'response:third'].entries()) {
			let response = responses[index]!
			expect(response.headers['grpc-status']).toBe(String(Status.OK))
			expect(Buffer.concat(response.chunks).equals(frame(expected))).toBe(true)
		}
	} finally {
		session.destroy()
	}
})
