import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { constants, createServer as createHttp2Server, createSecureServer } from 'node:http2'
import { type AddressInfo, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

import { collect, deferred, frame, rawServer, reply, requests, service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { Status } from './error.ts'

// Loopback sessions let tests control GOAWAY and stream reset ordering independently of YDB discovery.

test('connects lazily and reuses one session for multiple calls', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['value']))
	using client = new Client(peer.authority)

	expect(client.state).toBe('idle')
	expect(peer.sessions).toHaveLength(0)
	await client.connect(tc.signal)
	expect(client.state).toBe('ready')

	for (let index = 0; index < 3; index++) {
		let call = client.call(service.unary, '', { signal: tc.signal })
		// Sequential calls must reuse the connection after the previous RPC finishes.
		// eslint-disable-next-line no-await-in-loop
		let responses = await collect(call)

		expect(responses).toEqual(['value'])
	}

	expect(peer.sessions).toHaveLength(1)
	client.close()
	expect(client.state).toBe('closed')
})

test('shares an in-flight connection between concurrent callers', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['value']))
	using client = new Client(peer.authority)

	await Promise.all([
		client.connect(tc.signal),
		client.connect(tc.signal),
		client.connect(tc.signal),
	])
	await collect(client.call(service.unary, '', { signal: tc.signal }))

	expect(peer.sessions).toHaveLength(1)
})

test('does not connect for an already-aborted caller', async () => {
	await using peer = await rawServer((stream) => reply(stream, ['unexpected']))
	using client = new Client(peer.authority)
	let reason = new Error('cancel connect')

	await expect(client.connect(AbortSignal.abort(reason))).rejects.toBe(reason)
	expect(peer.sessions).toHaveLength(0)
	expect(client.state).toBe('idle')
})

test('close is idempotent and prevents later RPCs and reconnects', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['unexpected']))
	using client = new Client(peer.authority)
	client.close()
	client.close()

	await expect(client.connect(tc.signal)).rejects.toBeInstanceOf(Error)
	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toBeInstanceOf(Error)
	expect(client.state).toBe('closed')
	expect(peer.streams).toHaveLength(0)
})

test('close terminates outstanding calls without waiting for the peer', async (tc) => {
	let started = deferred()
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
		started.resolve()
	})
	using client = new Client(peer.authority)
	let response = collect(client.call(service.unary, '', { signal: tc.signal }))
	let failure = response.catch((error: unknown) => error)
	await started.promise

	client.close()

	expect(await failure).toBeInstanceOf(Error)
	expect(client.state).toBe('closed')
})

test('cancelling one RPC preserves another call on the same session', async (tc) => {
	let firstStarted = deferred()
	let secondStarted = deferred<() => void>()
	let calls = 0
	await using peer = await rawServer((stream) => {
		calls++

		if (calls === 1) {
			stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
			firstStarted.resolve()
		} else {
			secondStarted.resolve(() => reply(stream, ['survived']))
		}
	})
	using client = new Client(peer.authority)
	let controller = new AbortController()
	let reason = new Error('cancel only first')
	let first = collect(
		client.call(service.unary, '', {
			signal: AbortSignal.any([tc.signal, controller.signal]),
		})
	).catch((error: unknown) => error)
	await firstStarted.promise
	let second = collect(client.call(service.unary, '', { signal: tc.signal }))
	let finish = await secondStarted.promise

	controller.abort(reason)
	finish()

	expect(await first).toBe(reason)
	expect(await second).toEqual(['survived'])
	expect(peer.sessions).toHaveLength(1)
})

test('lets accepted streams finish after GOAWAY and sends new calls on a new session', async (tc) => {
	let calls = 0
	let finish = deferred<() => void>()
	await using peer = await rawServer((stream) => {
		calls++

		if (calls === 1) {
			stream.respond(
				{ ':status': 200, 'content-type': 'application/grpc' },
				{ waitForTrailers: true }
			)
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
			stream.write(frame('before goaway'))
			finish.resolve(() => stream.end(frame('after goaway')))
		} else {
			reply(stream, ['new connection'])
		}
	})
	using client = new Client(peer.authority)
	let first = client.call(service.serverStream, '', { signal: tc.signal })[Symbol.asyncIterator]()

	expect((await first.next()).value).toBe('before goaway')
	let session = peer.sessions[0]!
	session.goaway(constants.NGHTTP2_NO_ERROR, peer.streams[0]!.id)
	await new Promise<void>((resolve, reject) => {
		session.ping((error) => {
			if (error) {
				reject(error)
			} else {
				resolve()
			}
		})
	})

	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual(['new connection'])
	let end = await finish.promise
	end()
	expect((await first.next()).value).toBe('after goaway')
	expect((await first.next()).done).toBe(true)
	expect(peer.sessions).toHaveLength(2)
})

test('does not replay an RPC after a refused stream', async (tc) => {
	let calls = 0
	await using peer = await rawServer((stream) => {
		calls++

		if (calls === 1) {
			stream.close(constants.NGHTTP2_REFUSED_STREAM)
		} else {
			reply(stream, ['explicit retry'])
		}
	})
	using client = new Client(peer.authority)

	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toBeInstanceOf(Error)
	expect(calls).toBe(1)

	let retry = client.call(service.unary, '', { signal: tc.signal })
	let retriedResponses = await collect(retry)

	expect(retriedResponses).toEqual(['explicit retry'])
	expect(calls).toBe(2)
})

test('does not replay a call whose connection closes after receiving the request', async (tc) => {
	let calls = 0
	await using peer = await rawServer(async (stream) => {
		calls++

		// A disconnected server may already have applied the complete request.
		await requests(stream)

		stream.session?.destroy()
	})
	using client = new Client(peer.authority)

	let call = client.call(service.unary, 'non-idempotent', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toBeInstanceOf(Error)
	await setTimeout(10, undefined, { signal: tc.signal })
	expect(calls).toBe(1)
})

test('uses a custom CA and TLS server name for an IP endpoint', async (tc) => {
	await using files = {
		path: await mkdtemp(join(tmpdir(), 'ydb-grpc-tls-')),
		[Symbol.asyncDispose]() {
			return rm(this.path, { recursive: true, force: true })
		},
	}
	let keyPath = join(files.path, 'key.pem')
	let certPath = join(files.path, 'certificate.pem')
	await promisify(execFile)(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-subj',
			'/CN=grpc.test',
			'-addext',
			'subjectAltName=DNS:grpc.test',
			'-days',
			'1',
		],
		{ signal: tc.signal }
	)
	let certificate = await readFile(certPath)
	let secure = createSecureServer({ key: await readFile(keyPath), cert: certificate })
	await using peer = await rawServer((stream) => reply(stream, ['secure']), secure)
	using client = new Client(peer.authority.replace('http:', 'https:'), {
		tls: { ca: certificate, servername: 'grpc.test' },
	})

	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual(['secure'])
})

test('rejects an untrusted TLS certificate', async (tc) => {
	await using files = {
		path: await mkdtemp(join(tmpdir(), 'ydb-grpc-untrusted-')),
		[Symbol.asyncDispose]() {
			return rm(this.path, { recursive: true, force: true })
		},
	}
	let keyPath = join(files.path, 'key.pem')
	let certPath = join(files.path, 'certificate.pem')
	await promisify(execFile)(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-subj',
			'/CN=grpc.test',
			'-addext',
			'subjectAltName=DNS:grpc.test',
			'-days',
			'1',
		],
		{ signal: tc.signal }
	)
	let secure = createSecureServer({
		key: await readFile(keyPath),
		cert: await readFile(certPath),
	})
	await using peer = await rawServer((stream) => reply(stream, ['unexpected']), secure)
	using client = new Client(peer.authority.replace('http:', 'https:'), {
		tls: { servername: 'grpc.test' },
	})

	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = collect(call)

	await expect(responses).rejects.toBeInstanceOf(Error)
	expect(peer.streams).toHaveLength(0)
})

test('calls a loopback peer through a Unix domain socket', async (tc) => {
	await using files = {
		path: await mkdtemp(join(tmpdir(), 'ydb-grpc-unix-')),
		[Symbol.asyncDispose]() {
			return rm(this.path, { recursive: true, force: true })
		},
	}
	await using peer = await rawServer(
		(stream) => reply(stream, ['unix']),
		undefined,
		join(files.path, 'rpc.sock')
	)
	using client = new Client(peer.authority)

	let call = client.call(service.unary, '', { signal: tc.signal })
	let responses = await collect(call)

	expect(responses).toEqual(['unix'])
})

test('drains accepted responses after OK trailers and a graceful GOAWAY session close', async (tc) => {
	let trailers = deferred()
	let closed = deferred()
	await using peer = await rawServer((stream) => {
		let session = stream.session!
		session.once('close', closed.resolve)
		stream.respond(
			{ ':status': 200, 'content-type': 'application/grpc' },
			{ waitForTrailers: true }
		)
		stream.on('wantTrailers', () => {
			stream.sendTrailers({ 'grpc-status': '0' })
			session.goaway(constants.NGHTTP2_NO_ERROR, stream.id)
			session.close()
		})
		stream.end(Buffer.concat([frame('first'), frame('second')]))
	})
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', {
		signal: tc.signal,
		onTrailer: () => trailers.resolve(),
	})
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	await trailers.promise
	await closed.promise
	expect((await iterator.next()).value).toBe('second')
	expect((await iterator.next()).done).toBe(true)
})

test('times out connection setup when a TCP peer never sends HTTP/2 settings', async (tc) => {
	await using server = createTcpServer((socket) => socket.resume())
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	let { port } = server.address() as AddressInfo
	using client = new Client(`http://127.0.0.1:${port}`, { connectTimeoutMs: 25 })

	await expect(client.connect(tc.signal)).rejects.toMatchObject({ code: Status.UNAVAILABLE })
	expect(client.state).not.toBe('ready')
})

test('honors initial server concurrency limits before starting parallel RPCs', async (tc) => {
	await using peer = await rawServer(
		async (stream) => {
			await setTimeout(5, undefined, { signal: tc.signal })
			reply(stream, ['value'])
		},
		createHttp2Server({ settings: { maxConcurrentStreams: 1 } })
	)
	using client = new Client(peer.authority)

	let results = await Promise.all(
		Array.from({ length: 4 }, () =>
			collect(client.call(service.unary, '', { signal: tc.signal }))
		)
	)

	expect(results).toEqual([['value'], ['value'], ['value'], ['value']])
	expect(peer.sessions).toHaveLength(1)
	expect(peer.streams).toHaveLength(4)
})
