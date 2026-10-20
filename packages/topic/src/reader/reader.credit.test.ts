import { setTimeout as sleep } from 'node:timers/promises'

import {
	type StreamReadMessage_CommitOffsetRequest,
	type StreamReadMessage_FromClient,
	type StreamReadMessage_FromServer,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { AsyncQueue } from '@ydbjs/fsm/queue'
import { Server } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import { createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	readResponse,
	startPartitionSession,
} from './reader.fixtures.ts'

type ReadStream = {
	requests: AsyncIterator<StreamReadMessage_FromClient>
	responses: AsyncQueue<StreamReadMessage_FromServer>
	credits: bigint[]
}

function nextRequest(
	stream: ReadStream,
	kind: 'commitOffsetRequest'
): Promise<StreamReadMessage_CommitOffsetRequest>
function nextRequest(
	stream: ReadStream,
	kind: 'initRequest' | 'readRequest' | 'startPartitionSessionResponse'
): Promise<void>
async function nextRequest(
	stream: ReadStream,
	kind: 'initRequest' | 'readRequest' | 'startPartitionSessionResponse' | 'commitOffsetRequest'
): Promise<StreamReadMessage_CommitOffsetRequest | void> {
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop
		let next = await stream.requests.next()
		if (next.done) throw new Error(`Stream ended before ${kind}`)
		let request = next.value.clientMessage
		if (request.case === 'readRequest') stream.credits.push(request.value.bytesSize)
		if (request.case === kind) {
			if (request.case === 'commitOffsetRequest') return request.value
			return
		}
	}
}

function messageResponse(offset: bigint, size: number): StreamReadMessage_FromServer {
	return readResponse({
		partitionSessionId: 1n,
		messages: [{ offset, seqNo: offset + 1n, data: new Uint8Array(size) }],
	})
}

test('keeps retained responses within one credit window across repeated reconnects', async (tc) => {
	let streams = new AsyncQueue<ReadStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input, { signal }) {
			using responses = new AsyncQueue<StreamReadMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, credits: [] })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(stream, 'initRequest')
	stream.responses.push(initResponse())
	stream.responses.push(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await nextRequest(stream, 'startPartitionSessionResponse')
	expect(stream.credits).toEqual([1000n])
	stream.responses.push(messageResponse(0n, 1000))
	await expect.poll(() => reader.bufferedBytes).toBe(1000n)

	for (let i = 0; i < 3; i++) {
		stream.responses.close()
		// oxlint-disable-next-line no-await-in-loop
		stream = (await streams.take(tc.signal)).value
		// oxlint-disable-next-line no-await-in-loop
		await nextRequest(stream, 'initRequest')
		stream.responses.push(initResponse())
		stream.responses.push(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
		// The start response follows init handling, so any initial credit has already arrived.
		// oxlint-disable-next-line no-await-in-loop
		await nextRequest(stream, 'startPartitionSessionResponse')
		expect(stream.credits).toEqual([])
		expect(reader.bufferedBytes).toBe(1000n)
	}

	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([0n])
		expect(batch[0]!.payload.byteLength).toBe(1000)
		break
	}
	await nextRequest(stream, 'readRequest')
	expect(reader.bufferedBytes).toBe(0n)
	expect(stream.credits).toEqual([1000n])

	stream.responses.push(messageResponse(1n, 1000))
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([1n])
		break
	}
	await nextRequest(stream, 'readRequest')
	expect(reader.bufferedBytes).toBe(0n)
	expect(stream.credits).toEqual([1000n, 1000n])
})

test('accounts releases while the next stream is waiting for init', async (tc) => {
	let streams = new AsyncQueue<ReadStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input, { signal }) {
			using responses = new AsyncQueue<StreamReadMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, credits: [] })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(stream, 'initRequest')
	stream.responses.push(initResponse())
	stream.responses.push(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await nextRequest(stream, 'startPartitionSessionResponse')
	stream.responses.push(messageResponse(0n, 400))
	await expect.poll(() => reader.bufferedBytes).toBe(400n)
	stream.responses.close()

	let next: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(next, 'initRequest')
	let credit = nextRequest(next, 'readRequest')
	void credit.catch(() => {})
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch).toHaveLength(1)
		break
	}
	expect(reader.bufferedBytes).toBe(0n)
	// Keep the request iterator active while init is withheld; premature credit must be observable.
	await sleep(25, undefined, { signal: tc.signal })
	expect(next.credits).toEqual([])

	next.responses.push(initResponse())
	next.responses.push(startPartitionSession({ partitionSessionId: 2n, partitionId: 0n }))
	await credit
	await nextRequest(next, 'startPartitionSessionResponse')
	expect(next.credits).toEqual([1000n])
})

test('withholds new credit until inherited oversized responses fit the buffer window', async (tc) => {
	let streams = new AsyncQueue<ReadStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input, { signal }) {
			using responses = new AsyncQueue<StreamReadMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, credits: [] })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(stream, 'initRequest')
	stream.responses.push(initResponse())
	stream.responses.push(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await nextRequest(stream, 'startPartitionSessionResponse')
	stream.responses.push(messageResponse(0n, 600))
	stream.responses.push(messageResponse(1n, 800))
	await expect.poll(() => reader.bufferedBytes).toBe(1400n)
	stream.responses.close()
	let next: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(next, 'initRequest')
	next.responses.push(initResponse())
	next.responses.push(startPartitionSession({ partitionSessionId: 2n, partitionId: 0n }))
	await nextRequest(next, 'startPartitionSessionResponse')
	expect(next.credits).toEqual([])

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([0n])
		break
	}
	await nextRequest(next, 'readRequest')
	expect(reader.bufferedBytes).toBe(800n)
	expect(next.credits).toEqual([200n])

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch.map((message) => message.offset)).toEqual([1n])
		break
	}
	await nextRequest(next, 'readRequest')
	expect(reader.bufferedBytes).toBe(0n)
	expect(next.credits).toEqual([200n, 800n])
})

test('shares reconnect credit between old responses and newly received data', async (tc) => {
	let streams = new AsyncQueue<ReadStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input, { signal }) {
			using responses = new AsyncQueue<StreamReadMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, credits: [] })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(stream, 'initRequest')
	stream.responses.push(initResponse())
	stream.responses.push(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await nextRequest(stream, 'startPartitionSessionResponse')
	stream.responses.push(messageResponse(0n, 400))
	await expect.poll(() => reader.bufferedBytes).toBe(400n)
	stream.responses.close()
	let next: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(next, 'initRequest')
	next.responses.push(initResponse())
	next.responses.push(startPartitionSession({ partitionSessionId: 2n, partitionId: 1n }))
	await nextRequest(next, 'startPartitionSessionResponse')
	expect(next.credits).toEqual([600n])
	next.responses.push(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: new Uint8Array(600) }],
		})
	)
	await expect.poll(() => reader.bufferedBytes).toBe(1000n)

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch[0]!.payload.byteLength).toBe(400)
		break
	}
	await nextRequest(next, 'readRequest')
	expect(reader.bufferedBytes).toBe(600n)
	expect(next.credits).toEqual([600n, 400n])
	next.responses.push(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 1n, seqNo: 2n, data: new Uint8Array(400) }],
		})
	)
	await expect.poll(() => reader.bufferedBytes).toBe(1000n)

	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch[0]!.payload.byteLength).toBe(600)
		break
	}
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch[0]!.payload.byteLength).toBe(400)
		break
	}
	await nextRequest(next, 'readRequest')
	await nextRequest(next, 'readRequest')
	expect(reader.bufferedBytes).toBe(0n)
	expect(next.credits).toEqual([600n, 400n, 600n, 400n])
})

test('confirms a pending commit while retained messages withhold new stream read credit', async (tc) => {
	let streams = new AsyncQueue<ReadStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input, { signal }) {
			using responses = new AsyncQueue<StreamReadMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, credits: [] })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let starts = 0
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
		onPartitionSessionStart: async () => {
			starts += 1
		},
	})
	let stream: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(stream, 'initRequest')
	stream.responses.push(initResponse())
	stream.responses.push(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await nextRequest(stream, 'startPartitionSessionResponse')
	stream.responses.push(
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
	await nextRequest(stream, 'commitOffsetRequest')
	stream.responses.close()
	let next: ReadStream = (await streams.take(tc.signal)).value
	await nextRequest(next, 'initRequest')
	next.responses.push(initResponse(''))
	next.responses.push(startPartitionSession({ partitionSessionId: 2n, partitionId: 0n }))
	await nextRequest(next, 'startPartitionSessionResponse')
	let committed = await nextRequest(next, 'commitOffsetRequest')
	expect(committed.commitOffsets).toMatchObject([
		{ partitionSessionId: 2n, offsets: [{ start: 0n, end: 1n }] },
	])
	next.responses.push(commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 1n }]))
	await pending
	expect(starts).toBe(2)
	expect(reader.bufferedBytes).toBe(1000n)
	expect(next.credits).toEqual([])
})
