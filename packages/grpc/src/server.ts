import { once } from 'node:events'
import type { Socket } from 'node:net'
import {
	type Http2Server,
	type IncomingHttpHeaders,
	type OutgoingHttpHeaders,
	type ServerHttp2Session,
	type ServerHttp2Stream,
	constants,
	createSecureServer,
	createServer,
} from 'node:http2'

import { abortable } from '@ydbjs/abortable'

import { createDeadline } from './deadline.js'
import { MessageSizeError, RpcError, Status } from './error.js'
import { type Frame, createFrameStream, decompress } from './framing.js'
import { requestHeaders, responseMetadata } from './metadata.js'
import type {
	Metadata,
	MethodDefinition,
	RpcStatus,
	ServerContext,
	ServerOptions,
	ServiceDefinition,
	ServiceImplementation,
} from './types.js'

interface Method {
	definition: MethodDefinition
	handle(request: any, context: ServerContext): any
}

let connectionHeaders = new Set([
	'connection',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'upgrade',
	'http2-settings',
])

function requestDeadline(value: string | string[] | undefined): number | undefined {
	if (value === undefined) return undefined
	let match = typeof value === 'string' && /^(\d{1,8})([HMSmun])$/.exec(value)
	if (!match) throw new RpcError(Status.INVALID_ARGUMENT, 'Invalid grpc-timeout')
	let units: Record<string, number> = {
		H: 3600000,
		M: 60000,
		S: 1000,
		m: 1,
		u: 0.001,
		n: 0.000001,
	}
	return Date.now() + Number(match[1]) * units[match[2]!]!
}

function applicationHeaders(metadata: Metadata): OutgoingHttpHeaders {
	let headers = requestHeaders(metadata)
	for (let key of Object.keys(headers)) {
		if (connectionHeaders.has(key)) {
			throw new TypeError(`Invalid HTTP/2 response metadata key: ${key}`)
		}
		if (key.startsWith('grpc-') && key !== 'grpc-status-details-bin') delete headers[key]
	}
	delete headers['content-type']
	delete headers.te
	return headers
}

function failureStatus(error: unknown): RpcStatus {
	if (typeof error === 'object' && error !== null && 'code' in error) {
		let { code, details, metadata } = error as Partial<RpcStatus>
		if (Number.isInteger(code) && code! > Status.OK && code! <= Status.UNAUTHENTICATED) {
			return { code: code!, details: details ?? String(error), metadata: metadata ?? {} }
		}
	}
	return {
		code: Status.UNKNOWN,
		details: error instanceof Error ? error.message : String(error),
		metadata: {},
	}
}

async function* readRequests(
	stream: ServerHttp2Stream,
	method: MethodDefinition,
	encoding: string,
	limit: number,
	signal: AbortSignal
): AsyncGenerator<unknown> {
	signal.throwIfAborted()
	let frames = createFrameStream(limit, 'request')
	let abort = () => frames.destroy(signal.reason as Error)
	frames.on('error', () => {})
	signal.addEventListener('abort', abort, { once: true })
	stream.pipe(frames)
	try {
		for await (let batch of frames) {
			for (let frame of batch as Frame[]) {
				signal.throwIfAborted()
				let bytes = frame.data
				if (frame.compressed) {
					// oxlint-disable-next-line no-await-in-loop
					bytes = await decompress(frame, encoding, limit, 'request')
				}
				signal.throwIfAborted()
				let request: unknown
				try {
					request = method.requestDeserialize!(bytes)
				} catch (cause) {
					throw new RpcError(
						Status.INTERNAL,
						'Request deserialization failed',
						{},
						{ cause }
					)
				}
				yield request
			}
		}
	} finally {
		signal.removeEventListener('abort', abort)
		stream.unpipe(frames)
		frames.destroy()
	}
}

async function writeResponse(
	stream: ServerHttp2Stream,
	method: MethodDefinition,
	response: unknown,
	limit: number,
	signal: AbortSignal
): Promise<void> {
	let bytes: Uint8Array
	try {
		bytes = method.responseSerialize!(response)
	} catch (cause) {
		throw new RpcError(Status.INTERNAL, 'Response serialization failed', {}, { cause })
	}
	if (bytes.length > limit || bytes.length > 0xffffffff)
		throw new MessageSizeError('response', limit)
	signal.throwIfAborted()
	let header = Buffer.allocUnsafe(5)
	header[0] = 0
	header.writeUInt32BE(bytes.length, 1)
	let body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let offset = 0
	try {
		if (!stream.write(header)) await once(stream, 'drain', { signal })
		// Bound queued bytes so one large response does not exhaust the shared session budget.
		while (offset < body.length) {
			signal.throwIfAborted()
			let chunk = body.subarray(offset, offset + 64 * 1024)
			let canWrite = stream.write(chunk)
			offset += chunk.length
			if (!canWrite) {
				// oxlint-disable-next-line no-await-in-loop
				await once(stream, 'drain', { signal })
			}
		}
	} catch (error) {
		// Trailers cannot terminate a partially queued length-prefixed message.
		if (offset < body.length) {
			stream.close(
				signal.aborted ? constants.NGHTTP2_CANCEL : constants.NGHTTP2_INTERNAL_ERROR
			)
		}
		throw error
	}
}

async function serve(
	stream: ServerHttp2Stream,
	headers: IncomingHttpHeaders,
	rawHeaders: string[],
	method: Method | undefined,
	maxSendBytes: number,
	maxReceiveBytes: number
): Promise<void> {
	let controller = new AbortController()
	let { signal } = controller
	let completed = false
	let trailer: OutgoingHttpHeaders = {}
	let requests: AsyncGenerator<unknown> | undefined
	let responses: AsyncIterator<unknown> | undefined
	let abort = () => controller.abort(new RpcError(Status.CANCELLED, 'Call cancelled'))
	stream.once('aborted', abort)
	stream.once('error', abort)
	stream.once('close', abort)

	let sendHeader = (metadata: Metadata = {}) => {
		if (stream.headersSent) throw new Error('Response headers already sent')
		signal.throwIfAborted()
		stream.respond(
			{
				...applicationHeaders(metadata),
				':status': 200,
				'content-type': 'application/grpc',
				'grpc-accept-encoding': 'identity,gzip,deflate',
			},
			{ waitForTrailers: true }
		)
	}
	let finish = (status: RpcStatus) => {
		if (completed || stream.destroyed || stream.closed) return
		let statusMetadata: OutgoingHttpHeaders
		try {
			statusMetadata = applicationHeaders(status.metadata)
		} catch {
			status = { code: Status.INTERNAL, details: 'Invalid response metadata', metadata: {} }
			statusMetadata = {}
		}
		let trailers = {
			...trailer,
			...statusMetadata,
			'grpc-status': String(status.code),
			'grpc-message': encodeURIComponent(status.details),
		}
		completed = true
		if (!stream.headersSent) {
			stream.respond(
				{ ':status': 200, 'content-type': 'application/grpc', ...trailers },
				{ endStream: true }
			)
		} else {
			stream.once('wantTrailers', () => {
				try {
					if (!stream.destroyed) stream.sendTrailers(trailers)
				} catch {
					stream.close(constants.NGHTTP2_INTERNAL_ERROR)
				}
			})
			stream.end()
		}
	}

	try {
		if (headers[':method'] !== 'POST') {
			stream.respond({ ':status': 405 }, { endStream: true })
			return
		}
		if (!/^application\/grpc(?:[+;]|$)/i.test(String(headers['content-type'] ?? ''))) {
			stream.respond({ ':status': 415 }, { endStream: true })
			return
		}
		if (!method) throw new RpcError(Status.UNIMPLEMENTED, 'Unknown RPC method')
		let deadline = requestDeadline(headers['grpc-timeout'])
		using timer = createDeadline(deadline)
		let expire = () => controller.abort(timer!.signal.reason)
		timer?.signal.addEventListener('abort', expire, { once: true })
		if (timer?.signal.aborted) expire()
		let metadata
		try {
			metadata = { ...responseMetadata(headers, rawHeaders) }
		} catch (cause) {
			throw new RpcError(Status.INVALID_ARGUMENT, 'Invalid request metadata', {}, { cause })
		}
		delete metadata.te
		delete metadata['grpc-timeout']
		delete metadata['grpc-message-type']
		let context: ServerContext = {
			metadata,
			signal,
			deadline,
			peer: `${stream.session?.socket.remoteAddress ?? 'unix'}:${stream.session?.socket.remotePort ?? ''}`,
			sendHeader,
			setTrailer(value) {
				trailer = { ...trailer, ...applicationHeaders(value) }
			},
		}
		let encoding = String(headers['grpc-encoding'] ?? 'identity')
		requests = readRequests(stream, method.definition, encoding, maxReceiveBytes, signal)
		let request: unknown = requests
		if (!method.definition.requestStream) {
			let first = await abortable(signal, requests.next())
			if (first.done) throw new RpcError(Status.INTERNAL, 'Missing request message')
			let next = await abortable(signal, requests.next())
			if (!next.done) throw new RpcError(Status.INTERNAL, 'Too many request messages')
			request = first.value
		}
		signal.throwIfAborted()
		let result = method.handle(request, context)
		if (method.definition.responseStream) {
			responses = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
			while (true) {
				// oxlint-disable-next-line no-await-in-loop
				let next = await abortable(signal, Promise.resolve(responses.next()))
				signal.throwIfAborted()
				if (next.done) break
				if (!stream.headersSent) sendHeader()
				// oxlint-disable-next-line no-await-in-loop
				await writeResponse(stream, method.definition, next.value, maxSendBytes, signal)
			}
		} else {
			let response = await abortable(signal, Promise.resolve(result))
			signal.throwIfAborted()
			if (!stream.headersSent) sendHeader()
			await writeResponse(stream, method.definition, response, maxSendBytes, signal)
		}
		finish({ code: Status.OK, details: '', metadata: {} })
	} catch (error) {
		finish(failureStatus(signal.aborted ? signal.reason : error))
	} finally {
		for (let iterator of [requests, responses]) {
			try {
				// return() may be queued behind a handler's unresolved next().
				void Promise.resolve(iterator?.return?.(undefined)).catch(() => {})
			} catch {
				// Cleanup cannot replace the status already sent to the client.
			}
		}
	}
}

export class Server implements Disposable {
	#server: Http2Server
	#methods = new Map<string, Method>()
	#sessions = new Set<ServerHttp2Session>()
	#sockets = new Set<Socket>()
	#maxSendBytes: number
	#maxReceiveBytes: number
	#listening: Promise<number> | undefined
	#closing: Promise<void> | undefined
	#closed = false

	constructor(options: ServerOptions = {}) {
		this.#maxSendBytes = options.maxSendBytes ?? 64 * 1024 * 1024
		this.#maxReceiveBytes = options.maxReceiveBytes ?? 64 * 1024 * 1024
		for (let [name, value] of [
			['maxSendBytes', this.#maxSendBytes],
			['maxReceiveBytes', this.#maxReceiveBytes],
		] as const) {
			if (!Number.isSafeInteger(value) || value < 0)
				throw new RangeError(`${name} must be a non-negative integer`)
		}
		this.#server = options.tls
			? createSecureServer({ ...options.tls, allowHTTP1: false })
			: createServer()
		this.#server.on('connection', (socket) => {
			if (this.#closed) {
				socket.destroy()
				return
			}
			this.#sockets.add(socket)
			socket.once('close', () => this.#sockets.delete(socket))
		})
		this.#server.on('session', (session) => {
			if (this.#closed) {
				session.destroy()
				return
			}
			this.#sessions.add(session)
			session.on('error', () => {})
			session.once('close', () => this.#sessions.delete(session))
		})
		this.#server.on('stream', (stream: ServerHttp2Stream, headers, _flags, rawHeaders) => {
			if (this.#closed) {
				stream.close(constants.NGHTTP2_REFUSED_STREAM)
				return
			}
			let method = this.#methods.get(String(headers[':path']))
			void serve(
				stream,
				headers,
				rawHeaders,
				method,
				this.#maxSendBytes,
				this.#maxReceiveBytes
			).catch(() => {
				stream.close(constants.NGHTTP2_INTERNAL_ERROR)
			})
		})
	}

	add<Service extends ServiceDefinition>(
		service: Service,
		implementation: Partial<ServiceImplementation<Service>>
	): void {
		if (this.#closed) throw new Error('Server is closed')
		let methods: [string, Method][] = []
		for (let [name, handle] of Object.entries(implementation)) {
			let definition = service[name]
			if (!definition || typeof handle !== 'function')
				throw new TypeError(`Unknown service handler: ${name}`)
			if (!definition.requestDeserialize || !definition.responseSerialize)
				throw new TypeError(`Missing server codecs: ${name}`)
			if (
				this.#methods.has(definition.path) ||
				methods.some(([path]) => path === definition.path)
			) {
				throw new Error(`RPC method already registered: ${definition.path}`)
			}
			methods.push([definition.path, { definition, handle: handle as Method['handle'] }])
		}
		for (let [path, method] of methods) this.#methods.set(path, method)
	}

	listen(address = '127.0.0.1:0'): Promise<number> {
		if (this.#closed) return Promise.reject(new Error('Server is closed'))
		if (this.#listening) return Promise.reject(new Error('Server is already listening'))
		this.#listening = new Promise((resolve, reject) => {
			let failed = (error: Error) => reject(error)
			this.#server.once('error', failed)
			let ready = () => {
				this.#server.removeListener('error', failed)
				let bound = this.#server.address()
				resolve(typeof bound === 'object' && bound !== null ? bound.port : 0)
			}
			try {
				if (address.startsWith('unix:')) {
					let path = decodeURIComponent(new URL(address).pathname)
					if (!path || path.includes('\0'))
						throw new TypeError('Invalid Unix socket path')
					this.#server.listen(path, ready)
				} else {
					let url = new URL(`http://${address}`)
					this.#server.listen(
						Number(url.port || 80),
						url.hostname.replace(/^\[|\]$/g, ''),
						ready
					)
				}
			} catch (error) {
				this.#server.removeListener('error', failed)
				reject(error)
			}
		})
		return this.#listening
	}

	close(): Promise<void> {
		this.#closed = true
		this.#closing ??= (async () => {
			await this.#listening?.catch(() => {})
			let listenerClosed = new Promise<void>((resolve, reject) => {
				if (!this.#server.listening) {
					resolve()
					return
				}
				this.#server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
			let sessionsClosed: Promise<void>[] = []
			for (let session of this.#sessions) {
				if (session.destroyed) continue
				sessionsClosed.push(new Promise<void>((resolve) => session.once('close', resolve)))
				session.close()
			}
			let connectionsClosed = Promise.all(sessionsClosed).then(() => {
				// A TCP/TLS connection without an HTTP/2 session has no RPCs to drain.
				for (let socket of this.#sockets) socket.destroy()
				return undefined
			})
			await Promise.all([listenerClosed, connectionsClosed])
			this.#methods.clear()
			this.#sessions.clear()
			this.#sockets.clear()
		})()
		return this.#closing
	}

	destroy(): void {
		void this.close().catch(() => {})
		for (let session of this.#sessions) session.destroy()
		for (let socket of this.#sockets) socket.destroy()
		this.#methods.clear()
	}

	[Symbol.dispose](): void {
		this.destroy()
	}
}
