import { expect, test } from 'vitest'

import { createTopicReader } from './index.ts'
import {
	type FakeReadStream,
	type FakeTopicDriver,
	commitOffsetResponse,
	initResponse,
	makeFakeTopicDriver,
	readResponse,
	settle,
	startPartitionSession,
} from './reader.fixtures.ts'

// A fake stream makes reconnects land with retained responses or a pending init;
// these timing windows cannot be selected deterministically against real YDB.
let initStream = async function initStream(fake: FakeTopicDriver): Promise<FakeReadStream> {
	let stream = await fake.waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse())
	await settle()
	return stream
}

let credits = function credits(stream: FakeReadStream): bigint[] {
	return stream.sent.flatMap((message) =>
		message.clientMessage.case === 'readRequest' ? [message.clientMessage.value.bytesSize] : []
	)
}

let send = function send(stream: FakeReadStream, offset: bigint, size: number): void {
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset, seqNo: offset + 1n, data: new Uint8Array(size) }],
		})
	)
}

test('keeps retained responses within one credit window across repeated reconnects', async (tc) => {
	let fake = makeFakeTopicDriver()
	using reader = createTopicReader(fake.driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream = await initStream(fake)
	expect(credits(stream)).toEqual([1000n])
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await stream.waitForStartResponse()
	send(stream, 0n, 1000)
	await settle()
	expect(reader.bufferedBytes).toBe(1000n)

	for (let i = 0; i < 3; i++) {
		stream.disconnect()
		// oxlint-disable-next-line no-await-in-loop
		stream = await initStream(fake)
		expect(credits(stream)).toEqual([])
		expect(reader.bufferedBytes).toBe(1000n)
	}

	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([0n])
		expect(batch[0]!.payload.byteLength).toBe(1000)
		break
	}
	await settle()
	expect(reader.bufferedBytes).toBe(0n)
	expect(credits(stream)).toEqual([1000n])

	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await stream.waitForStartResponse()
	send(stream, 1n, 1000)
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([1n])
		break
	}
	await settle()
	expect(reader.bufferedBytes).toBe(0n)
	expect(credits(stream)).toEqual([1000n, 1000n])
})

test('accounts releases while the next stream is waiting for init', async (tc) => {
	let fake = makeFakeTopicDriver()
	using reader = createTopicReader(fake.driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream = await initStream(fake)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await stream.waitForStartResponse()
	send(stream, 0n, 400)
	await settle()
	stream.disconnect()

	let next = await fake.waitForNextStream()
	await next.waitForInit()
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch).toHaveLength(1)
		break
	}
	await settle()
	expect(reader.bufferedBytes).toBe(0n)
	expect(credits(next)).toEqual([])

	next.respond(initResponse())
	await settle()
	expect(credits(next)).toEqual([1000n])
})

test('withholds new credit until inherited oversized responses fit the buffer window', async (tc) => {
	let fake = makeFakeTopicDriver()
	using reader = createTopicReader(fake.driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream = await initStream(fake)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await stream.waitForStartResponse()
	send(stream, 0n, 600)
	send(stream, 1n, 800)
	await settle()
	expect(reader.bufferedBytes).toBe(1400n)
	stream.disconnect()
	let next = await initStream(fake)
	expect(credits(next)).toEqual([])

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([0n])
		break
	}
	await settle()
	expect(reader.bufferedBytes).toBe(800n)
	expect(credits(next)).toEqual([200n])

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([1n])
		break
	}
	await settle()
	expect(reader.bufferedBytes).toBe(0n)
	expect(credits(next)).toEqual([200n, 800n])
})

test('shares reconnect credit between old responses and newly received data', async (tc) => {
	let fake = makeFakeTopicDriver()
	using reader = createTopicReader(fake.driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream = await initStream(fake)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await stream.waitForStartResponse()
	send(stream, 0n, 400)
	await settle()
	stream.disconnect()
	let next = await initStream(fake)
	expect(credits(next)).toEqual([600n])
	next.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 1n }))
	await next.waitForStartResponse()
	next.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: new Uint8Array(600) }],
		})
	)
	await settle()
	expect(reader.bufferedBytes).toBe(1000n)

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch[0]!.payload.byteLength).toBe(400)
		break
	}
	await settle()
	expect(reader.bufferedBytes).toBe(600n)
	expect(credits(next)).toEqual([600n, 400n])
	next.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 1n, seqNo: 2n, data: new Uint8Array(400) }],
		})
	)
	await settle()
	expect(reader.bufferedBytes).toBe(1000n)

	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch[0]!.payload.byteLength).toBe(600)
		break
	}
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch[0]!.payload.byteLength).toBe(400)
		break
	}
	await settle()
	expect(reader.bufferedBytes).toBe(0n)
	expect(credits(next)).toEqual([600n, 400n, 600n, 400n])
})

test('confirms a pending commit while retained messages withhold new stream read credit', async (tc) => {
	let fake = makeFakeTopicDriver()
	let starts = 0
	using reader = createTopicReader(fake.driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
		onPartitionSessionStart: async () => {
			starts += 1
		},
	})
	let first = await initStream(fake)
	first.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await first.waitForStartResponse()
	first.respond(
		readResponse({
			partitionSessionId: 1n,
			bytesSize: 1000n,
			messages: [0n, 1n].map((offset) => ({
				offset,
				seqNo: offset + 1n,
				data: new Uint8Array([1]),
			})),
		})
	)
	let pending: Promise<void> | undefined
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		pending = reader.commit(batch)
		break
	}
	await first.waitForCommit()
	first.disconnect()
	let next = await fake.waitForNextStream()
	await next.waitForInit()
	next.respond(initResponse(''))
	next.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 0n }))
	await next.waitForStartResponse()
	let committed = await next.waitForCommit()
	expect(committed.commitOffsets).toMatchObject([
		{ partitionSessionId: 2n, offsets: [{ start: 0n, end: 1n }] },
	])
	next.respond(commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 1n }]))
	await pending
	expect(starts).toBe(2)
	expect(reader.bufferedBytes).toBe(1000n)
	expect(credits(next)).toEqual([])
})
