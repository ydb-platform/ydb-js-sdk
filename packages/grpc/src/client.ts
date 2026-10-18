import { once } from 'node:events'
import {
	type ClientHttp2Session,
	type ClientHttp2Stream,
	type IncomingHttpHeaders,
	type OutgoingHttpHeaders,
	connect as connectHttp2,
	constants,
} from 'node:http2'
import { connect as connectSocket } from 'node:net'
import { finished as streamFinished } from 'node:stream'
import { connect as connectTls } from 'node:tls'

import { abortable } from '@ydbjs/abortable'

import { type Deadline, createDeadline } from './deadline.js'
import { MessageSizeError, RpcError, Status } from './error.js'
import { type Frame, createFrameStream, decompress } from './framing.js'
import { requestHeaders, responseMetadata } from './metadata.js'
import type { CallOptions, ClientOptions, MethodDefinition, RpcStatus, Transport } from './types.js'

interface Session {
	http2: ClientHttp2Session
	ready: Promise<void>
	connected: boolean
	retired: boolean
	waiters: number
	pendingCalls: Set<(error: unknown) => void>
	connectTimer?: NodeJS.Timeout | undefined
	keepaliveTimer?: NodeJS.Timeout | undefined
	pingTimer?: NodeJS.Timeout | undefined
}

function errorDetails(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function errorStatus(error: unknown, code = Status.UNKNOWN): RpcStatus {
	return error instanceof RpcError ? error : { code, details: errorDetails(error), metadata: {} }
}

function statusFromHeaders(
	headers: IncomingHttpHeaders,
	rawHeaders?: string[]
): RpcStatus | undefined {
	let value = headers['grpc-status']
	if (value === undefined) {
		return undefined
	}
	if (
		typeof value !== 'string' ||
		!/^[0-9]+$/.test(value) ||
		Number(value) > Status.UNAUTHENTICATED
	) {
		throw new RpcError(Status.INTERNAL, 'Malformed grpc-status')
	}
	let details = headers['grpc-message']
	if (typeof details !== 'string') {
		details = ''
	}
	try {
		details = decodeURIComponent(details)
	} catch {
		// Preserve malformed escapes instead of hiding the server's status.
	}
	return { code: Number(value), details, metadata: responseMetadata(headers, rawHeaders) }
}

function httpError(code: number): RpcError {
	let mapping: Record<number, Status> = {
		400: Status.INTERNAL,
		401: Status.UNAUTHENTICATED,
		403: Status.PERMISSION_DENIED,
		404: Status.UNIMPLEMENTED,
		429: Status.UNAVAILABLE,
		502: Status.UNAVAILABLE,
		503: Status.UNAVAILABLE,
		504: Status.UNAVAILABLE,
	}
	return new RpcError(mapping[code] ?? Status.UNKNOWN, `Unexpected HTTP status ${code}`)
}

function streamError(code: number, sessionDestroyed: boolean): RpcError {
	// Node also uses CANCEL when the underlying connection disappears.
	if (code === constants.NGHTTP2_CANCEL && sessionDestroyed) {
		return new RpcError(Status.UNAVAILABLE, 'HTTP/2 session closed')
	}

	let mapping: Record<number, Status> = {
		[constants.NGHTTP2_REFUSED_STREAM]: Status.UNAVAILABLE,
		[constants.NGHTTP2_CANCEL]: Status.CANCELLED,
		[constants.NGHTTP2_ENHANCE_YOUR_CALM]: Status.RESOURCE_EXHAUSTED,
		[constants.NGHTTP2_INADEQUATE_SECURITY]: Status.PERMISSION_DENIED,
	}
	return new RpcError(mapping[code] ?? Status.INTERNAL, `HTTP/2 stream reset with code ${code}`)
}

function timeoutHeader(deadline: number): string {
	let remaining = Math.max(0, deadline - Date.now())
	for (let [scale, unit] of [
		[1, 'm'],
		[1000, 'S'],
		[60000, 'M'],
		[3600000, 'H'],
	] as const) {
		let value = Math.ceil(remaining / scale)
		if (value < 100000000) {
			return `${value}${unit}`
		}
	}
	return '99999999H'
}

async function* oneRequest<Request>(request: Request): AsyncIterable<Request> {
	yield request
}

async function writeRequests<Request, Response>(
	stream: ClientHttp2Stream,
	method: MethodDefinition<Request, Response>,
	input: Request | AsyncIterable<Request>,
	limit: number,
	signal: AbortSignal
): Promise<void> {
	let requests = method.requestStream
		? (input as AsyncIterable<Request>)
		: oneRequest(input as Request)
	let iterator = requests[Symbol.asyncIterator]()
	let finished = false
	let closeInput = () => {
		if (finished) {
			return
		}
		finished = true
		try {
			// return() can wait behind a producer's unresolved next().
			void Promise.resolve(iterator.return?.()).catch(() => {})
		} catch {
			// Cleanup must not replace the RPC's terminal result.
		}
	}
	signal.addEventListener('abort', closeInput, { once: true })
	try {
		while (true) {
			signal.throwIfAborted()
			// oxlint-disable-next-line no-await-in-loop
			let next = await abortable(signal, Promise.resolve(iterator.next()))
			signal.throwIfAborted()
			if (next.done) {
				finished = true
				stream.end()
				return
			}
			let bytes: Uint8Array
			try {
				bytes = method.requestSerialize(next.value)
			} catch (error) {
				throw new RpcError(
					Status.INTERNAL,
					'Request serialization failed',
					{},
					{ cause: error }
				)
			}
			if (bytes.length > limit || bytes.length > 0xffffffff) {
				throw new MessageSizeError('request', limit)
			}
			let header = Buffer.allocUnsafe(5)
			header[0] = 0
			header.writeUInt32BE(bytes.length, 1)
			let body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			let drain: Promise<unknown> | undefined
			stream.cork()
			try {
				let canWriteAfterHeader = stream.write(header)
				let canWriteAfterBody = true
				if (body.length > 0) {
					canWriteAfterBody = stream.write(body)
				}
				if (!canWriteAfterHeader || !canWriteAfterBody) {
					drain = once(stream, 'drain', { signal })
				}
			} finally {
				stream.uncork()
			}
			if (drain) {
				// oxlint-disable-next-line no-await-in-loop
				await drain
			}
		}
	} finally {
		signal.removeEventListener('abort', closeInput)
		closeInput()
	}
}

export class Client implements Transport, Disposable {
	#authority: URL
	#socketPath: string | undefined
	#options: ClientOptions
	#current: Session | undefined
	#sessions = new Set<Session>()
	#responseConsumers = new Set<(error: unknown) => void>()
	#closed = false

	constructor(authority: string | URL, options: ClientOptions = {}) {
		let url = new URL(authority)
		if (url.username || url.password) {
			throw new TypeError('Transport authority cannot contain credentials')
		}
		if (url.protocol === 'grpc:') {
			url = new URL(`http://${url.host}`)
		} else if (url.protocol === 'grpcs:') {
			url = new URL(`https://${url.host}`)
		} else if (url.protocol === 'unix:') {
			this.#socketPath = decodeURIComponent(url.pathname)
			if (!this.#socketPath || this.#socketPath.includes('\0')) {
				throw new TypeError('Invalid Unix socket path')
			}
			url = new URL(options.tls ? 'https://localhost' : 'http://localhost')
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new TypeError('Transport authority must use http, https, grpc, grpcs or unix')
		}
		this.#authority = url
		this.#options = {
			...options,
			maxSendBytes: options.maxSendBytes ?? 64 * 1024 * 1024,
			maxReceiveBytes: options.maxReceiveBytes ?? 64 * 1024 * 1024,
			connectTimeoutMs: options.connectTimeoutMs ?? 30000,
		}
		for (let key of [
			'maxSendBytes',
			'maxReceiveBytes',
			'connectTimeoutMs',
			'keepaliveIntervalMs',
			'keepaliveTimeoutMs',
		] as const) {
			let value = this.#options[key]
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
				throw new RangeError(`${key} must be a non-negative integer`)
			}
		}
		for (let key of ['connectionWindowBytes', 'streamWindowBytes'] as const) {
			let value = options[key]
			if (
				value !== undefined &&
				(!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
			) {
				throw new RangeError(`${key} must be an integer between 0 and 2147483647`)
			}
		}
	}

	get state(): 'idle' | 'connecting' | 'ready' | 'closed' {
		if (this.#closed) {
			return 'closed'
		}
		if (!this.#current || this.#current.http2.destroyed || this.#current.retired) {
			return 'idle'
		}
		return this.#current.connected ? 'ready' : 'connecting'
	}

	async connect(signal?: AbortSignal): Promise<void> {
		await this.#session(signal)
	}

	async #session(signal?: AbortSignal): Promise<Session> {
		signal?.throwIfAborted()
		if (this.#closed) {
			throw new RpcError(Status.CANCELLED, 'Client is closed')
		}
		let session = this.#current
		if (!session || session.retired || session.http2.destroyed || session.http2.closed) {
			session = this.#openSession()
		}
		session.waiters += 1
		session.http2.ref()
		try {
			await abortable(signal, session.ready)
			signal?.throwIfAborted()
			if (session.retired || session.http2.destroyed || session.http2.closed) {
				throw new RpcError(Status.UNAVAILABLE, 'Connection closed before starting the RPC')
			}
			return session
		} finally {
			session.waiters -= 1
			this.#updateRef(session)
		}
	}

	#stopTimers(session: Session): void {
		clearTimeout(session.connectTimer)
		clearInterval(session.keepaliveTimer)
		clearTimeout(session.pingTimer)
		session.keepaliveTimer = undefined
		session.pingTimer = undefined
	}

	#startKeepalive(session: Session): void {
		let options = this.#options
		if (!options.keepaliveIntervalMs) {
			return
		}
		let http2 = session.http2
		session.keepaliveTimer = setInterval(() => {
			if (session.retired || http2.destroyed || session.pingTimer) {
				return
			}
			session.pingTimer = setTimeout(() => {
				http2.destroy(new RpcError(Status.UNAVAILABLE, 'Keepalive ping timed out'))
			}, options.keepaliveTimeoutMs ?? 10000).unref()
			http2.ping((error) => {
				clearTimeout(session.pingTimer)
				session.pingTimer = undefined
				if (error && !session.retired && !http2.destroyed) {
					http2.destroy(error)
				}
			})
		}, options.keepaliveIntervalMs).unref()
	}

	#releaseSessionCall(session: Session | undefined, call: (error: unknown) => void): void {
		if (!session) {
			return
		}
		session.pendingCalls.delete(call)
		this.#updateRef(session)
	}

	#updateRef(session: Session): void {
		if (session.waiters === 0 && session.pendingCalls.size === 0) {
			session.http2.unref()
		}
	}

	#openSession(): Session {
		let ready = Promise.withResolvers<void>()
		let options = this.#options
		let http2 = connectHttp2(this.#authority, {
			...options.tls,
			settings: { enablePush: false, initialWindowSize: options.streamWindowBytes },
			// Queued request bodies must not make Node reject response headers on another RPC.
			maxSessionMemory: Number.MAX_SAFE_INTEGER,
			...(this.#socketPath && {
				createConnection: () =>
					options.tls
						? connectTls({
								...options.tls,
								path: this.#socketPath!,
								ALPNProtocols: ['h2'],
							})
						: connectSocket({ path: this.#socketPath! }),
			}),
		})
		let session: Session = {
			http2,
			ready: ready.promise,
			connected: false,
			retired: false,
			waiters: 0,
			pendingCalls: new Set(),
		}
		this.#current = session
		this.#sessions.add(session)
		void ready.promise.catch(() => {})
		http2.once('remoteSettings', () => {
			clearTimeout(session.connectTimer)
			try {
				if (options.connectionWindowBytes !== undefined) {
					http2.setLocalWindowSize(options.connectionWindowBytes)
				}
				session.connected = true
				this.#updateRef(session)
				ready.resolve()
				this.#startKeepalive(session)
			} catch (error) {
				http2.destroy(error as Error)
			}
		})
		http2.on('error', (error) => {
			let failure = new RpcError(
				Status.UNAVAILABLE,
				'HTTP/2 session failed',
				{},
				{ cause: error }
			)
			ready.reject(failure)
			for (let fail of session.pendingCalls) {
				fail(failure)
			}
		})
		http2.on('goaway', (code, _lastStreamId, data) => {
			if (
				!session.retired &&
				code === constants.NGHTTP2_ENHANCE_YOUR_CALM &&
				data?.equals(Buffer.from('too_many_pings')) &&
				options.keepaliveIntervalMs
			) {
				options.keepaliveIntervalMs = Math.min(options.keepaliveIntervalMs * 2, 2147483647)
			}

			session.retired = true
			this.#stopTimers(session)
			if (this.#current === session) {
				this.#current = undefined
			}
			http2.close()
		})
		http2.once('close', () => {
			this.#stopTimers(session)
			this.#sessions.delete(session)
			if (this.#current === session) {
				this.#current = undefined
			}
			let error = new RpcError(Status.UNAVAILABLE, 'HTTP/2 session closed')
			ready.reject(error)
			for (let fail of session.pendingCalls) {
				fail(error)
			}
		})
		if (options.connectTimeoutMs) {
			session.connectTimer = setTimeout(() => {
				http2.destroy(new RpcError(Status.UNAVAILABLE, 'Connection timed out'))
			}, options.connectTimeoutMs).unref()
		}
		return session
	}

	async *call<Request, Response>(
		method: MethodDefinition<Request, Response>,
		input: Request | AsyncIterable<Request>,
		options: CallOptions = {}
	): AsyncGenerator<Response, void, undefined> {
		let responseController = new AbortController()
		let requestController = new AbortController()
		let stream: ClientHttp2Stream | undefined
		let session: Session | undefined
		let frames: ReturnType<typeof createFrameStream> | undefined
		let stopWatchingStream: (() => void) | undefined
		let deadline: Deadline | undefined
		let expiresAt: number | undefined
		let statusReported = false
		let responseSettled = false
		let hasResponseError = false
		let responseError: unknown
		let serverStatus: RpcStatus | undefined
		let encoding = 'identity'
		let receivedMessages = 0
		let onDeadline = () => fail(deadline!.signal.reason)
		let stopDeadline = () => {
			deadline?.signal.removeEventListener('abort', onDeadline)
			deadline?.[Symbol.dispose]()
		}
		let notifyStatus = (status: RpcStatus) => {
			if (statusReported) {
				return
			}
			statusReported = true
			try {
				options.onStatus?.(status)
			} catch {
				// Observer errors must not replace the terminal transport status.
			}
		}
		let fail = (error: unknown, status = errorStatus(error)) => {
			if (responseSettled) {
				return
			}
			responseSettled = true
			hasResponseError = true
			responseError = error
			responseController.abort(error)
			requestController.abort(error)
			frames?.destroy()
			stopDeadline()
			options.signal?.removeEventListener('abort', onAbort)
			this.#releaseSessionCall(session, failBeforeServerStatus)
			this.#responseConsumers.delete(fail)
			if (stream && !(stream.readableEnded && stream.writableFinished)) {
				stream.close(constants.NGHTTP2_CANCEL)
			}
			notifyStatus(status)
		}
		let onAbort = () =>
			fail(options.signal!.reason, errorStatus(options.signal!.reason, Status.CANCELLED))
		let failBeforeServerStatus = (error: unknown) => {
			if (!serverStatus) {
				// A peer's deadline reset can be observed before the local timer callback runs.
				if (
					error instanceof RpcError &&
					error.code === Status.CANCELLED &&
					deadline &&
					expiresAt! <= Date.now()
				) {
					error = new RpcError(Status.DEADLINE_EXCEEDED, 'Deadline exceeded')
				}
				fail(error)
			}
		}
		let acceptServerStatus = (headers: IncomingHttpHeaders, rawHeaders?: string[]) => {
			let status = statusFromHeaders(headers, rawHeaders)
			if (status) {
				serverStatus = status
				requestController.abort()
				stopDeadline()
				// Buffered responses remain cancellable after the session releases this RPC.
				this.#releaseSessionCall(session, failBeforeServerStatus)
				options.onTrailer?.(status.metadata)
				notifyStatus(status)
			}
		}
		this.#responseConsumers.add(fail)
		options.signal?.addEventListener('abort', onAbort, { once: true })
		try {
			if (options.signal?.aborted) {
				onAbort()
			}
			responseController.signal.throwIfAborted()
			expiresAt = options.deadline === undefined ? undefined : Number(options.deadline)
			deadline = createDeadline(expiresAt)
			if (deadline?.signal.aborted) {
				onDeadline()
			} else {
				deadline?.signal.addEventListener('abort', onDeadline, { once: true })
			}
			session = await this.#session(responseController.signal)
			responseController.signal.throwIfAborted()
			let outgoingHeaders: OutgoingHttpHeaders = {
				...requestHeaders(options.metadata),
				':method': 'POST',
				':path': method.path,
				'content-type': 'application/grpc',
				te: 'trailers',
				'grpc-encoding': 'identity',
				'grpc-accept-encoding': 'identity,gzip,deflate',
				'user-agent': this.#options.userAgent ?? 'ydbjs-grpc',
			}
			delete outgoingHeaders['grpc-timeout']
			if (deadline) {
				outgoingHeaders['grpc-timeout'] = timeoutHeader(expiresAt!)
			}
			try {
				stream = session.http2.request(outgoingHeaders)
			} catch (error) {
				throw new RpcError(
					Status.UNAVAILABLE,
					'Failed to create HTTP/2 stream',
					{},
					{ cause: error }
				)
			}
			session.pendingCalls.add(failBeforeServerStatus)
			session.http2.ref()
			stream.on('response', (headers, _flags, rawHeaders) => {
				if (responseSettled) {
					return
				}
				try {
					options.onHeader?.(responseMetadata(headers, rawHeaders))
					acceptServerStatus(headers, rawHeaders)
					if (responseSettled) {
						return
					}
					if (headers[':status'] !== 200 && !serverStatus) {
						throw httpError(Number(headers[':status']))
					}
					let contentType = headers['content-type']
					if (
						typeof contentType !== 'string' ||
						!/^application\/grpc(?:\+[^;\s]+)?(?:;|$)/i.test(contentType)
					) {
						throw new RpcError(Status.UNKNOWN, 'Invalid gRPC content-type')
					}
					let responseEncoding = headers['grpc-encoding']
					if (typeof responseEncoding === 'string') {
						encoding = responseEncoding
					}
				} catch (error) {
					fail(error)
				}
			})
			stream.on('trailers', (headers) => {
				if (!responseSettled) {
					try {
						acceptServerStatus(headers)
					} catch (error) {
						fail(error)
					}
				}
			})
			stream.on('end', () => requestController.abort())
			stream.on('error', (error: NodeJS.ErrnoException) => {
				if (error.code === 'ERR_HTTP2_STREAM_ERROR') {
					failBeforeServerStatus(streamError(stream!.rstCode, session!.http2.destroyed))
					return
				}
				failBeforeServerStatus(
					new RpcError(Status.UNAVAILABLE, 'HTTP/2 stream failed', {}, { cause: error })
				)
			})
			stream.on('aborted', () =>
				failBeforeServerStatus(streamError(stream!.rstCode, session!.http2.destroyed))
			)
			stream.on('close', () => {
				requestController.abort()
				// Normal EOF can precede consumption of complete buffered gRPC frames.
				if (
					!responseSettled &&
					!serverStatus &&
					(stream!.rstCode !== constants.NGHTTP2_NO_ERROR || !stream!.readableEnded)
				) {
					failBeforeServerStatus(streamError(stream!.rstCode, session!.http2.destroyed))
				}
			})
			frames = createFrameStream(this.#options.maxReceiveBytes!)
			frames.on('error', fail)
			stopWatchingStream = streamFinished(stream, { writable: false }, (error) => {
				if (error) {
					frames!.destroy(error)
				}
			})
			stream.pipe(frames)
			void writeRequests(
				stream,
				method,
				input,
				this.#options.maxSendBytes!,
				requestController.signal
			).catch((error) => {
				if (!requestController.signal.aborted) {
					fail(error)
				}
			})
			for await (let batch of frames.iterator({ destroyOnReturn: false })) {
				responseController.signal.throwIfAborted()
				for (let frame of batch as Frame[]) {
					responseController.signal.throwIfAborted()
					let bytes = frame.data
					if (frame.compressed) {
						// oxlint-disable-next-line no-await-in-loop
						bytes = await abortable(
							responseController.signal,
							decompress(frame, encoding, this.#options.maxReceiveBytes!)
						)
					}
					let response: Response | undefined
					try {
						response = method.responseDeserialize(bytes)
					} catch (error) {
						throw new RpcError(
							Status.INTERNAL,
							'Response deserialization failed',
							{},
							{ cause: error }
						)
					}
					receivedMessages += 1
					if (!method.responseStream && receivedMessages > 1) {
						throw new RpcError(
							Status.INTERNAL,
							'Received multiple responses for a unary RPC'
						)
					}
					responseController.signal.throwIfAborted()
					yield response
					// A suspended generator otherwise retains the last decoded response.
					response = undefined
				}
			}
			responseController.signal.throwIfAborted()
			if (!serverStatus) {
				throw new RpcError(Status.UNKNOWN, 'RPC ended without grpc-status')
			}
			if (serverStatus.code !== Status.OK) {
				throw new RpcError(serverStatus.code, serverStatus.details, serverStatus.metadata)
			}
			if (!method.responseStream && receivedMessages !== 1) {
				throw new RpcError(Status.INTERNAL, 'Received no response for a unary RPC')
			}
			responseSettled = true
			notifyStatus(serverStatus)
		} catch (error) {
			fail(error)
			throw hasResponseError ? responseError : error
		} finally {
			if (!responseSettled) {
				fail(new RpcError(Status.CANCELLED, 'Response consumer stopped'))
			}
			requestController.abort()
			stopDeadline()
			options.signal?.removeEventListener('abort', onAbort)
			this.#releaseSessionCall(session, failBeforeServerStatus)
			this.#responseConsumers.delete(fail)
			stopWatchingStream?.()
			if (frames) {
				stream?.unpipe(frames)
				frames.destroy()
			}
			if (stream && !(stream.readableEnded && stream.writableFinished)) {
				stream.close(constants.NGHTTP2_CANCEL)
			}
		}
	}

	close(): void {
		if (this.#closed) {
			return
		}
		this.#closed = true
		let error = new RpcError(Status.CANCELLED, 'Client is closed')
		for (let fail of this.#responseConsumers) {
			fail(error)
		}
		for (let session of this.#sessions) {
			this.#stopTimers(session)
			session.http2.destroy()
		}
		this.#current = undefined
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
