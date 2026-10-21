import { type ClientHttp2Session, type IncomingHttpHeaders, connect } from 'node:http2'

import { expect, test } from 'vitest'

import { frame, service } from '../tests/fixtures.ts'
import { RpcError, Server, Status } from './index.ts'

async function request(session: ClientHttp2Session, value: string, signal: AbortSignal) {
	let stream = session.request(
		{
			':method': 'POST',
			':path': service.unary.path,
			'content-type': 'application/grpc',
		},
		{ signal }
	)
	let headers: IncomingHttpHeaders = {}
	let chunks: Buffer[] = []
	stream.on('response', (received) => Object.assign(headers, received))
	stream.on('trailers', (received) => Object.assign(headers, received))
	stream.end(frame(value))
	for await (let chunk of stream) chunks.push(chunk as Buffer)
	return { headers, body: Buffer.concat(chunks) }
}

test.for(
	(
		[
			['Connection', 'keep-alive'],
			['keep-alive', 'timeout=5'],
			['proxy-connection', 'keep-alive'],
			['transfer-encoding', 'chunked'],
			['upgrade', 'h2c'],
			['http2-settings', 'AAMAAABkAAQAAP__'],
		] as const
	).flatMap(([key, value]) => [
		{ key, value, operation: 'setTrailer', code: Status.UNKNOWN },
		{ key, value, operation: 'RpcError', code: Status.INTERNAL },
	])
)(
	'rejects $key in $operation after sending headers',
	async ({ key, value, operation, code }, tc) => {
		using server = new Server()
		server.add(service, {
			unary(input, context) {
				if (input === 'valid') return 'response'
				context.sendHeader({ 'x-started': 'true' })
				let metadata = { [key]: value }
				if (operation === 'RpcError')
					throw new RpcError(Status.PERMISSION_DENIED, 'denied', metadata)
				context.setTrailer(metadata)
				return 'unexpected'
			},
		})
		let port = await server.listen()
		let session = connect(`http://127.0.0.1:${port}`)
		try {
			let failed = await request(session, value, tc.signal)

			expect(failed.headers['x-started']).toBe('true')
			expect(failed.headers['grpc-status']).toBe(String(code))
			expect(failed.headers[key.toLowerCase()]).toBeUndefined()
			expect(failed.body.length).toBe(0)
			let successful = await request(session, 'valid', tc.signal)

			expect(successful.headers['grpc-status']).toBe(String(Status.OK))
			expect(successful.body).toEqual(frame('response'))
		} finally {
			session.destroy()
		}
	}
)

// Repeated singleton fields pass metadata validation but fail inside Node's sendTrailers().
test.for(['setTrailer', 'RpcError'])(
	'contains a trailer transport error from %s within its RPC',
	async (operation, tc) => {
		using server = new Server()
		server.add(service, {
			unary(value, context) {
				if (value === 'valid') return 'response'
				context.sendHeader({})
				let metadata = { 'content-length': ['1', '2'] }
				if (operation === 'RpcError')
					throw new RpcError(Status.PERMISSION_DENIED, 'denied', metadata)
				context.setTrailer(metadata)
				return 'response'
			},
		})
		let port = await server.listen()
		let session = connect(`http://127.0.0.1:${port}`)
		try {
			await expect(request(session, 'invalid', tc.signal)).rejects.toMatchObject({
				code: 'ERR_HTTP2_STREAM_ERROR',
				message: expect.stringContaining('NGHTTP2_INTERNAL_ERROR'),
			})
			let successful = await request(session, 'valid', tc.signal)

			expect(successful.headers['grpc-status']).toBe(String(Status.OK))
			expect(successful.body).toEqual(frame('response'))
		} finally {
			session.destroy()
		}
	}
)
