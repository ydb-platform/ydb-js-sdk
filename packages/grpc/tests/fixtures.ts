import {
	type Http2Server,
	type IncomingHttpHeaders,
	type ServerHttp2Session,
	type ServerHttp2Stream,
	createServer,
} from 'node:http2'
import type { AddressInfo } from 'node:net'

import type { MethodDefinition } from '../src/types.ts'

export function method<RequestStream extends boolean, ResponseStream extends boolean>(
	name: string,
	requestStream: RequestStream,
	responseStream: ResponseStream
): MethodDefinition<string, string> & {
	requestStream: RequestStream
	responseStream: ResponseStream
} {
	return {
		path: `/test.Transport/${name}`,
		requestStream,
		responseStream,
		requestSerialize: (value: string) => Buffer.from(value),
		requestDeserialize: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
		responseSerialize: (value: string) => Buffer.from(value),
		responseDeserialize: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
	}
}

export let service = {
	unary: method('Unary', false, false),
	serverStream: method('ServerStream', false, true),
	clientStream: method('ClientStream', true, false),
	bidi: method('Bidi', true, true),
}

export function deferred<T = void>() {
	return Promise.withResolvers<T>()
}

export function frame(value: string | Uint8Array, compressed = false): Buffer {
	let body = typeof value === 'string' ? Buffer.from(value) : value
	let header = Buffer.alloc(5)
	header[0] = Number(compressed)
	header.writeUInt32BE(body.byteLength, 1)

	return Buffer.concat([header, body])
}

export function reply(
	stream: ServerHttp2Stream,
	messages: (string | Uint8Array)[],
	headers: IncomingHttpHeaders = {},
	trailers: IncomingHttpHeaders = { 'grpc-status': '0' }
) {
	stream.respond(
		{ ':status': 200, 'content-type': 'application/grpc', ...headers },
		{ waitForTrailers: true }
	)
	stream.on('wantTrailers', () => stream.sendTrailers(trailers))

	for (let message of messages) {
		stream.write(frame(message))
	}

	stream.end()
}

export async function requests(stream: ServerHttp2Stream): Promise<string[]> {
	let chunks: Buffer[] = []

	for await (let chunk of stream) {
		chunks.push(Buffer.from(chunk))
	}

	let bytes = Buffer.concat(chunks)
	let values: string[] = []
	let offset = 0

	while (offset < bytes.length) {
		let length = bytes.readUInt32BE(offset + 1)
		values.push(bytes.subarray(offset + 5, offset + 5 + length).toString())
		offset += 5 + length
	}

	return values
}

export async function rawServer(
	handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void | Promise<void>,
	server: Http2Server = createServer(),
	socketPath?: string
) {
	let sessions: ServerHttp2Session[] = []
	let streams: ServerHttp2Stream[] = []
	let errors: unknown[] = []

	server.on('session', (session) => {
		sessions.push(session)
		session.on('error', () => {})
	})
	server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
		streams.push(stream)
		stream.on('error', () => {})

		Promise.resolve(handler(stream, headers)).catch((error) => {
			errors.push(error)
			stream.destroy()
		})
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		if (socketPath) {
			server.listen(socketPath, resolve)
		} else {
			server.listen(0, '127.0.0.1', resolve)
		}
	})

	let address = server.address()!
	let authority =
		typeof address === 'string'
			? `unix://${address}`
			: `http://127.0.0.1:${(address as AddressInfo).port}`

	return {
		server,
		sessions,
		streams,
		errors,
		authority,
		async [Symbol.asyncDispose]() {
			for (let session of sessions) {
				session.destroy()
			}

			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error)
					} else {
						resolve()
					}
				})
			})
		},
	}
}

export async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	let result: T[] = []

	for await (let value of values) {
		result.push(value)
	}

	return result
}
