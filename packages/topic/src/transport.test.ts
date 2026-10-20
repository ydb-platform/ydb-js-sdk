import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_FromClient,
	type StreamReadMessage_FromServer,
	StreamWriteMessage_FromServerSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { AsyncQueue } from '@ydbjs/fsm/queue'
import { Server } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import {
	makeFakeTopicDriver as makeReaderDriver,
	initResponse as readInit,
	settle,
	updateTokenResponse,
} from './reader/reader.fixtures.ts'
import { ReaderTransport } from './reader/transport.ts'
import {
	makeFakeTopicDriver as makeWriterDriver,
	initResponse as writeInit,
} from './writer/writer.fixtures.ts'
import { WriterTransport } from './writer/transport.ts'

// A fake controls token resolution and old-stream EOF independently of reconnect.
// Real YDB cannot deterministically order these client-side continuations.
let transports = {
	reader() {
		let fake = makeReaderDriver()
		let transport = new ReaderTransport(fake.driver, { consumer: 'c', topicsReadSettings: [] })
		return {
			driver: fake.driver,
			transport,
			connect: () => transport.connect(),
			async nextStream() {
				let stream = await fake.waitForNextStream()
				await stream.waitForInit()
				stream.respond(readInit())
				await settle()
				return { ...stream, acknowledgeToken: () => stream.respond(updateTokenResponse()) }
			},
			[Symbol.dispose]() {
				transport.destroy()
			},
		}
	},
	writer() {
		let fake = makeWriterDriver()
		let transport = new WriterTransport(fake.driver, { path: '/t', producerId: 'p' })
		return {
			driver: fake.driver,
			transport,
			connect: () => transport.connect(true),
			async nextStream() {
				let stream = await fake.waitForNextStream()
				await stream.waitForInit()
				stream.respond(writeInit(0n))
				await settle()
				return {
					...stream,
					acknowledgeToken: () =>
						stream.respond(
							create(StreamWriteMessage_FromServerSchema, {
								status: StatusIds_StatusCode.SUCCESS,
								serverMessage: { case: 'updateTokenResponse', value: {} },
							})
						),
				}
			},
			[Symbol.dispose]() {
				transport.destroy()
			},
		}
	},
}

for (let [name, make] of Object.entries(transports)) {
	test.for(['resolved', 'rejected'] as const)(
		`${name} stops waiting for a $0 token when destroyed`,
		async (outcome) => {
			using fixture = make()
			let token = Promise.withResolvers<string>()
			let tokenError = new Error('Late token failure')
			using acquisition = vi
				.spyOn(fixture.driver, 'token', 'get')
				.mockReturnValue(token.promise)
			fixture.connect()
			let stream = await fixture.nextStream()
			let settled = false
			let failure: unknown
			let refresh = fixture.transport.sendUpdateToken().then(
				() => {
					settled = true
				},
				(error: unknown) => {
					settled = true
					failure = error
				}
			)
			fixture.transport.destroy(new Error('Transport stopped'))
			try {
				await settle()
				expect(settled).toBe(true)
				expect(stream.wasAborted()).toBe(true)
				expect(acquisition).toHaveBeenCalledOnce()
			} finally {
				if (outcome === 'resolved') token.resolve('shared-token')
				else token.reject(tokenError)
				await refresh
			}
			let updates = stream.sent.filter(
				(message) => message.clientMessage.case === 'updateTokenRequest'
			)
			expect(updates).toHaveLength(0)
			expect(failure).toBeUndefined()
			let sharedResult = await token.promise.catch((error: unknown) => error)
			expect(sharedResult).toBe(outcome === 'resolved' ? 'shared-token' : tokenError)
		}
	)

	test(`${name} discards a token resolved after its stream was replaced`, async () => {
		using fixture = make()
		let oldToken = Promise.withResolvers<string>()
		vi.spyOn(fixture.driver, 'token', 'get')
			.mockReturnValueOnce(oldToken.promise)
			.mockResolvedValue('current-token')
		fixture.connect()
		await fixture.nextStream()
		let oldRefresh = fixture.transport.sendUpdateToken()
		fixture.connect()
		let current = await fixture.nextStream()
		await fixture.transport.sendUpdateToken()
		oldToken.resolve('old-token')
		await oldRefresh
		await settle()
		let updates = current.sent.filter(
			(message) => message.clientMessage.case === 'updateTokenRequest'
		)
		expect(updates).toHaveLength(1)
		expect(updates[0]!.clientMessage.value).toMatchObject({ token: 'current-token' })
		expect(current.wasAborted()).toBe(false)
	})

	test(`${name} keeps current token acquisition pending when an old refresh fails`, async () => {
		using fixture = make()
		let oldToken = Promise.withResolvers<string>()
		let currentToken = Promise.withResolvers<string>()
		let token = vi
			.spyOn(fixture.driver, 'token', 'get')
			.mockReturnValueOnce(oldToken.promise)
			.mockReturnValue(currentToken.promise)
		fixture.connect()
		await fixture.nextStream()
		let oldRefresh = fixture.transport.sendUpdateToken().catch(() => {})
		fixture.connect()
		let current = await fixture.nextStream()
		let currentRefresh = fixture.transport.sendUpdateToken()
		oldToken.reject(new Error('Old credentials request failed'))
		await oldRefresh
		await fixture.transport.sendUpdateToken()
		currentToken.resolve('current-token')
		await currentRefresh
		await settle()
		expect(token).toHaveBeenCalledTimes(2)
		expect(
			current.sent.filter((message) => message.clientMessage.case === 'updateTokenRequest')
		).toHaveLength(1)
	})

	test(`${name} coalesces concurrent token requests`, async () => {
		using fixture = make()
		let token = vi.spyOn(fixture.driver, 'token', 'get').mockResolvedValue('token')
		fixture.connect()
		let stream = await fixture.nextStream()
		await Promise.all([
			fixture.transport.sendUpdateToken(),
			fixture.transport.sendUpdateToken(),
		])
		expect(token).toHaveBeenCalledTimes(1)
		stream.acknowledgeToken()
		await settle()
		await fixture.transport.sendUpdateToken()
		await settle()
		expect(token).toHaveBeenCalledTimes(2)
		expect(
			stream.sent.filter((message) => message.clientMessage.case === 'updateTokenRequest')
		).toHaveLength(2)
	})

	test(`${name} keeps a replacement stream alive after the old stream ends`, async () => {
		using fixture = make()
		fixture.connect()
		let old = await fixture.nextStream()
		fixture.connect()
		let current = await fixture.nextStream()
		await settle()
		expect(old.wasAborted()).toBe(true)
		expect(current.wasAborted()).toBe(false)
	})

	test(`${name} terminates its event iterator when closed`, async () => {
		using fixture = make()
		fixture.connect()
		let stream = await fixture.nextStream()
		let events = fixture.transport.events[Symbol.asyncIterator]()
		expect((await events.next()).value?.type).toBe('transport.stream.init_response')
		let createClient = vi.spyOn(fixture.driver, 'createClient')
		fixture.transport.close()
		expect(await events.next()).toMatchObject({ done: true })
		expect(stream.wasAborted()).toBe(true)
		fixture.connect()
		await expect(fixture.transport.sendUpdateToken()).resolves.toBeUndefined()
		await settle()
		expect(createClient).not.toHaveBeenCalled()
	})

	test(`${name} reports a failed request stream and cancels the call`, async () => {
		using fixture = make()
		let failure = new Error('Outgoing stream failed')
		let signal: AbortSignal | undefined
		let failedStream = function (
			_input: AsyncIterable<unknown>,
			options?: { signal?: AbortSignal }
		): AsyncIterable<never> {
			signal = options?.signal

			return {
				[Symbol.asyncIterator]() {
					return { next: () => Promise.reject(failure) }
				},
			}
		}
		vi.spyOn(fixture.driver, 'createClient').mockReturnValue({
			streamRead: failedStream,
			streamWrite: failedStream,
		} as never)
		let events = fixture.transport.events[Symbol.asyncIterator]()

		fixture.connect()
		let disconnected = await events.next()

		expect(disconnected.value).toMatchObject({ type: 'transport.stream.disconnected' })
		expect(disconnected.value?.error).toBe(failure)
		expect(signal?.aborted).toBe(true)
	})

	test(`${name} does not open a stream after close interrupts driver readiness`, async () => {
		using fixture = make()
		let ready = Promise.withResolvers<void>()
		vi.spyOn(fixture.driver, 'ready').mockReturnValue(ready.promise)
		let createClient = vi.spyOn(fixture.driver, 'createClient')
		fixture.connect()
		await settle()
		fixture.transport.close()
		await settle()
		ready.resolve()
		await settle()
		expect(createClient).not.toHaveBeenCalled()
	})
}

test.for(['reader', 'writer'] as const)(
	'$0 retries token acquisition after a provider failure on the current stream',
	async (name, tc) => {
		let streams: AbortSignal[] = []
		let tokens: string[] = []
		let updated = Promise.withResolvers<void>()
		using server = new Server()
		server.add(TopicServiceDefinition, {
			async *streamRead(requests, context) {
				streams.push(context.signal)
				for await (let request of requests) {
					let message = request.clientMessage
					if (message.case === 'initRequest') yield readInit()
					else if (message.case === 'updateTokenRequest') {
						tokens.push(message.value.token)
						updated.resolve()
					}
				}
			},
			async *streamWrite(requests, context) {
				streams.push(context.signal)
				for await (let request of requests) {
					let message = request.clientMessage
					if (message.case === 'initRequest') yield writeInit(0n)
					else if (message.case === 'updateTokenRequest') {
						tokens.push(message.value.token)
						updated.resolve()
					}
				}
			},
		})
		let port = await server.listen('127.0.0.1:0')
		let getToken = vi.fn<() => Promise<string>>().mockResolvedValue('initial-token')
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.enable_discovery': false,
			credentialsProvider: { getToken },
		})
		let transport =
			name === 'reader'
				? new ReaderTransport(driver, { consumer: 'c', topicsReadSettings: [] })
				: new WriterTransport(driver, { path: '/t', producerId: 'p' })
		try {
			if (transport instanceof WriterTransport) transport.connect(true)
			else transport.connect()
			let events = transport.events[Symbol.asyncIterator]()
			let initialized = events.next().then((event) => !event.done && event.value.type)
			let eventType = await abortable(tc.signal, initialized)
			expect(eventType).toBe('transport.stream.init_response')

			let failure = new Error('Token provider unavailable')
			getToken.mockClear().mockRejectedValueOnce(failure).mockResolvedValue('renewed-token')
			let failedRefresh = transport.sendUpdateToken()
			await expect(failedRefresh).rejects.toBe(failure)
			expect(tokens).toEqual([])
			expect(streams[0]!.aborted).toBe(false)

			await transport.sendUpdateToken()
			await abortable(tc.signal, updated.promise)
			expect(getToken).toHaveBeenCalledTimes(2)
			expect(tokens).toEqual(['renewed-token'])
			expect(streams).toHaveLength(1)
			expect(streams[0]!.aborted).toBe(false)
		} finally {
			transport.destroy()
		}
	}
)

test('reader sends a new token when the server does not acknowledge an unchanged token', async () => {
	using fixture = transports.reader()
	vi.spyOn(fixture.driver, 'token', 'get')
		.mockResolvedValueOnce('unchanged-token')
		.mockResolvedValue('renewed-token')
	fixture.connect()
	let stream = await fixture.nextStream()

	await fixture.transport.sendUpdateToken()
	await settle()
	await fixture.transport.sendUpdateToken()
	await settle()

	expect(
		stream.sent
			.filter((message) => message.clientMessage.case === 'updateTokenRequest')
			.map((message) => message.clientMessage.value)
	).toMatchObject([{ token: 'unchanged-token' }, { token: 'renewed-token' }])
})

test('reader bounds queued token refreshes while outgoing requests are blocked', async () => {
	let fake = makeReaderDriver()
	let responses = new AsyncQueue<StreamReadMessage_FromServer>()
	let requests: AsyncIterable<StreamReadMessage_FromClient> | undefined
	vi.spyOn(fake.driver, 'createClient').mockReturnValue({
		streamRead(input: AsyncIterable<StreamReadMessage_FromClient>) {
			requests = input
			return responses
		},
	} as never)
	let token = vi.spyOn(fake.driver, 'token', 'get').mockResolvedValue('token')
	let transport = new ReaderTransport(fake.driver, { consumer: 'c', topicsReadSettings: [] })
	using _ = {
		[Symbol.dispose]() {
			transport.destroy()
			responses.destroy()
		},
	}
	transport.connect()
	await settle()

	await transport.sendUpdateToken()
	await transport.sendUpdateToken()
	await transport.sendUpdateToken()
	expect(token).toHaveBeenCalledTimes(1)

	let iterator = requests![Symbol.asyncIterator]()
	expect((await iterator.next()).value.clientMessage.case).toBe('initRequest')
	expect((await iterator.next()).value.clientMessage.case).toBe('updateTokenRequest')
	await transport.sendUpdateToken()
	expect(token).toHaveBeenCalledTimes(2)
	await iterator.return?.()
})
