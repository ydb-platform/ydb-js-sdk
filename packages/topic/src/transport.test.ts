import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_FromClient,
	type StreamReadMessage_FromServer,
	StreamWriteMessage_FromServerSchema,
} from '@ydbjs/api/topic'
import { AsyncQueue } from '@ydbjs/fsm/queue'
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
