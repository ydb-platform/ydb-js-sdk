import type {
	StreamWriteMessage_InitRequest,
	StreamWriteMessage_WriteRequest,
} from '@ydbjs/api/topic'
import { subscribe, tracingChannel, unsubscribe } from 'node:diagnostics_channel'

import { Codec, type StreamWriteMessage_FromServer, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { AsyncQueue } from '@ydbjs/fsm/queue'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test, vi } from 'vitest'
import { RpcError, Server, Status } from '@ydbjs/grpc'

import { GZIP_CODEC } from '../codec.ts'
import type { TX } from '../tx.ts'
import {
	type WriteStream,
	failureResponse,
	initResponse,
	nextRequest,
	tick,
	writeResponse,
} from './writer.fixtures.ts'
import { createTopicTxWriter, createTopicWriter } from './writer.ts'
import { publishAcknowledged } from './diagnostics.ts'
import type { AckStatus } from './types.ts'

let bytes = function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values)
}
let makeFakeTx = function makeFakeTx() {
	let onCommit: ((signal?: AbortSignal) => Promise<void> | void) | undefined
	let onRollback: ((error: unknown, signal?: AbortSignal) => Promise<void> | void) | undefined
	let onClose: ((committed: boolean, signal?: AbortSignal) => Promise<void> | void) | undefined
	let tx = {
		sessionId: 'tx-session',
		transactionId: 'tx-1',
		onCommit: (fn: (signal?: AbortSignal) => Promise<void> | void) => (onCommit = fn),
		onRollback: (fn: (error: unknown, signal?: AbortSignal) => Promise<void> | void) =>
			(onRollback = fn),
		onClose: (fn: (committed: boolean, signal?: AbortSignal) => Promise<void> | void) =>
			(onClose = fn),
	} as unknown as TX
	return {
		tx,
		commit: (signal?: AbortSignal): Promise<void> | void => onCommit?.(signal),
		rollback: (error: unknown): Promise<void> | void => onRollback?.(error),
		close: (committed: boolean): Promise<void> | void => onClose?.(committed),
	}
}
let collect = function collect<T = unknown>(name: string): { payloads: T[] } & Disposable {
	let payloads: T[] = []
	let fn = (message: unknown) => payloads.push(message as T)
	subscribe(name, fn)
	return {
		payloads,
		[Symbol.dispose]() {
			unsubscribe(name, fn)
		},
	}
}
let collectTrace = function collectTrace(
	name: string
): { counts: { start: number; asyncEnd: number; error: number } } & Disposable {
	let counts = { start: 0, asyncEnd: 0, error: 0 }
	let ch = tracingChannel(name)
	let handlers = {
		start: () => (counts.start += 1),
		asyncEnd: () => (counts.asyncEnd += 1),
		error: () => (counts.error += 1),
	}
	ch.start.subscribe(handlers.start)
	ch.asyncEnd.subscribe(handlers.asyncEnd)
	ch.error.subscribe(handlers.error)
	return {
		counts,
		[Symbol.dispose]() {
			ch.start.unsubscribe(handlers.start)
			ch.asyncEnd.unsubscribe(handlers.asyncEnd)
			ch.error.unsubscribe(handlers.error)
		},
	}
}

test('assigns auto seqNos at send time and acknowledges a flush', async (tc) => {
	let initialized = Promise.withResolvers<StreamWriteMessage_InitRequest>()
	let received = Promise.withResolvers<StreamWriteMessage_WriteRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					initialized.resolve(message.value)
					yield initResponse(0n)
				}
				if (message.case === 'writeRequest') {
					received.resolve(message.value)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	writer.write(bytes(1))
	writer.write(bytes(2))
	let flushed = writer.flush(tc.signal)
	let init = await initialized.promise
	expect(init.getLastSeqNo).toBe(true)
	expect(init.producerId).toBe('p')
	let request = await received.promise
	let seqNos = request.messages.map((message) => message.seqNo)
	expect(seqNos).toEqual([1n, 2n])
	await expect(flushed).resolves.toBe(2n)
	await writer.close(tc.signal)
})

test('uses distinct producer identities for independently created default writers', async (tc) => {
	let producers: string[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					producers.push(message.value.producerId)
					yield initResponse(0n)
				}
				if (message.case === 'writeRequest') yield writeResponse(message.value.messages)
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using first = createTopicWriter(driver, { topic: '/t' })
	using second = createTopicWriter(driver, { topic: '/t' })
	first.write(bytes(1))
	second.write(bytes(2))
	await Promise.all([first.flush(tc.signal), second.flush(tc.signal)])
	expect(producers).toHaveLength(2)
	expect(producers[0]).not.toBe('')
	expect(producers[1]).not.toBe('')
	expect(producers[1]).not.toBe(producers[0])
})

test('continues auto seqNo from the recovered server high-water mark', async (tc) => {
	let received = Promise.withResolvers<StreamWriteMessage_WriteRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					yield initResponse(41n)
				}
				if (message.case === 'writeRequest') {
					received.resolve(message.value)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	writer.write(bytes(1))
	await writer.flush(tc.signal)
	let request = await received.promise
	expect(request.messages[0]!.seqNo).toBe(42n)
})

test('buffers writes received before the session is initialized', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	writer.write(bytes(7))

	stream.responses.push(initResponse(10n))

	let request = await nextRequest(stream.requests, 'writeRequest')
	expect(request.messages[0]!.seqNo).toBe(11n)
})

test('resends unacked messages after a transparent reconnect', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	writer.write(bytes(2))
	await nextRequest(first.requests, 'writeRequest')
	first.responses.push(writeResponse([{ seqNo: 1n }]))

	first.responses.close()
	let second: WriteStream = (await streams.take(tc.signal)).value
	let secondInit = await nextRequest(second.requests, 'initRequest')
	expect(secondInit.getLastSeqNo).toBe(false)

	second.responses.push(initResponse(1n))

	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages.map((m) => m.seqNo)).toEqual([2n])
})

test.for([
	{ name: 'clean end', error: undefined },
	{
		name: 'server deadline',
		error: Object.assign(new Error('deadline'), {
			code: Status.DEADLINE_EXCEEDED,
			details: 'deadline',
			metadata: {},
		}),
	},
	{ name: 'server timeout', error: new YDBError(StatusIds_StatusCode.TIMEOUT, []) },
	{ name: 'expired session', error: new YDBError(StatusIds_StatusCode.SESSION_EXPIRED, []) },
	{ name: 'indeterminate result', error: new YDBError(StatusIds_StatusCode.UNDETERMINED, []) },
])('preserves the pending flush across $name', async ({ error }, tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(first.requests, 'writeRequest')

	let flushed = writer.flush(tc.signal)
	let settledEarly = false
	void flushed.then(() => (settledEarly = true)).catch(() => (settledEarly = true))

	if (error instanceof YDBError) {
		first.responses.push(failureResponse(error.code))
	} else if (error) {
		first.responses.fail(error)
	} else {
		first.responses.close()
	}

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	expect(settledEarly).toBe(false)
	second.responses.push(initResponse(0n))

	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages[0]!.seqNo).toBe(1n)
	second.responses.push(writeResponse([{ seqNo: 1n }]))

	await expect(flushed).resolves.toBe(1n)
})

test('resolves a pending flush when a reconnect deduplicates all inflight messages', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let acknowledged: Array<[bigint, AckStatus]> = []
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: (seqNo, status) => acknowledged.push([seqNo, status]),
	})

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	writer.write(bytes(2))
	await nextRequest(first.requests, 'writeRequest')

	let flushed = writer.flush(tc.signal)
	first.responses.close()

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	second.responses.push(initResponse(2n))

	await expect(flushed).resolves.toBe(2n)
	expect(acknowledged).toEqual([
		[1n, 'skipped'],
		[2n, 'skipped'],
	])

	writer.write(bytes(3))
	let nextFlush = writer.flush(tc.signal)
	let request = await nextRequest(second.requests, 'writeRequest')
	let sequenceNumbers = request.messages.map((message) => message.seqNo)
	expect(sequenceNumbers).toEqual([3n])
	let payload = Array.from(request.messages[0]!.data)
	expect(payload).toEqual([3])

	second.responses.push(writeResponse([{ seqNo: 3n }]))
	await expect(nextFlush).resolves.toBe(3n)
	expect(acknowledged).toEqual([
		[1n, 'skipped'],
		[2n, 'skipped'],
		[3n, 'written'],
	])
})

test('does not replay an acknowledged write after the stream disconnects', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let acknowledged: Array<[bigint, AckStatus]> = []
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: (seqNo, status) => acknowledged.push([seqNo, status]),
	})

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))
	writer.write(bytes(1))
	let firstFlush = writer.flush(tc.signal)
	let firstWrite = await nextRequest(first.requests, 'writeRequest')
	let firstSequences = firstWrite.messages.map((message) => message.seqNo)
	expect(firstSequences).toEqual([1n])

	first.responses.push(writeResponse([{ seqNo: 1n }]))
	await expect(firstFlush).resolves.toBe(1n)
	expect(acknowledged).toEqual([[1n, 'written']])
	first.responses.close()

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	second.responses.push(initResponse(1n))
	writer.write(bytes(2))
	let secondFlush = writer.flush(tc.signal)
	let secondWrite = await nextRequest(second.requests, 'writeRequest')
	let secondSequences = secondWrite.messages.map((message) => message.seqNo)
	expect(secondSequences).toEqual([2n])
	let payload = Array.from(secondWrite.messages[0]!.data)
	expect(payload).toEqual([2])

	second.responses.push(writeResponse([{ seqNo: 2n }]))
	await expect(secondFlush).resolves.toBe(2n)
	await writer.close(tc.signal)
	expect(acknowledged).toEqual([
		[1n, 'written'],
		[2n, 'written'],
	])
})

test('rejects a non-positive maxInflightCount', async () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	expect(() =>
		createTopicWriter(driver, { topic: '/t', producer: 'p', maxInflightCount: 0 })
	).toThrow(/maxInflightCount/)
})

test('rejects a non-positive maxBufferBytes', async () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	expect(() =>
		createTopicWriter(driver, { topic: '/t', producer: 'p', maxBufferBytes: 0n })
	).toThrow(/maxBufferBytes/)
})

test('fails terminally and rejects the flush on a non-retryable error', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	let flushed = writer.flush()
	stream.responses.push(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(flushed).rejects.toBeDefined()
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('drains buffered messages before a graceful close resolves', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	let closed = false
	let closing = writer.close().then(() => (closed = true))

	expect(closed).toBe(false)

	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await closing
	expect(closed).toBe(true)
})

test('rejects pending flush when destroyed', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	let flushed = writer.flush()
	writer.destroy(new Error('stopped'))

	await expect(flushed).rejects.toThrow('stopped')
})

test('rejects a manual seqNo after auto mode was chosen', async () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	writer.write(bytes(1))
	expect(() => writer.write(bytes(2), { seqNo: 5n })).toThrow(/auto mode/)
})

test('rejects a non-increasing manual seqNo', async () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	writer.write(bytes(1), { seqNo: 5n })
	expect(() => writer.write(bytes(2), { seqNo: 5n })).toThrow(/strictly increasing/)
})

test('throws synchronously when a write would exceed maxBufferBytes', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		maxBufferBytes: 4n,
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1, 2, 3)) // 3 bytes buffered, under the 4-byte cap
	expect(() => writer.write(bytes(4, 5))).toThrow(/buffer is full/i)
})

test('reclaims buffer budget once acknowledgments free bytes', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		maxBufferBytes: 3n,
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1, 2, 3)) // fills the 3-byte cap exactly
	expect(() => writer.write(bytes(4))).toThrow(/buffer is full/i)

	await nextRequest(stream.requests, 'writeRequest')
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await writer.flush(tc.signal)
	expect(() => writer.write(bytes(4, 5, 6))).not.toThrow()
})

test('publishes opened, session, and acknowledgment diagnostics events', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	type Opened = { producer: string; config: { maxInflightCount: number; maxBufferBytes: bigint } }
	type Ack = { written: number; skipped: number; writtenInTx: number }
	using opened = collect<Opened>('ydb:topic.writer.opened')
	using sessions = collect<{ producer: string; lastSeqNo: bigint }>(
		'ydb:topic.writer.session.started'
	)
	using acks = collect<Ack>('ydb:topic.writer.acknowledged')

	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', maxInflightCount: 7 })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(7n))

	writer.write(bytes(1))
	let flushed = writer.flush()
	await nextRequest(stream.requests, 'writeRequest')
	stream.responses.push(writeResponse([{ seqNo: 8n }]))
	await flushed
	expect(opened.payloads).toHaveLength(1)
	expect(opened.payloads[0]).toMatchObject({ producer: 'p', config: { maxInflightCount: 7 } })
	expect(opened.payloads[0]!.config.maxBufferBytes).toBeGreaterThan(0n)

	expect(sessions.payloads).toHaveLength(1)
	expect(sessions.payloads[0]).toMatchObject({ producer: 'p', lastSeqNo: 7n })

	let writtenCount = acks.payloads.reduce((sum, ack) => sum + ack.written, 0)
	expect(writtenCount).toBe(1)
	expect(acks.payloads).toMatchObject([{ written: 1, skipped: 0, writtenInTx: 0 }])
})

test('counts acknowledgment statuses only when diagnostics have subscribers', () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	let scope = { driver: driver.identity, topic: '/t', producer: 'p' }
	let statuses = new Map<bigint, AckStatus>([
		[1n, 'written'],
		[2n, 'written'],
		[3n, 'skipped'],
		[4n, 'writtenInTx'],
	])
	let values = vi.spyOn(statuses, 'values')

	publishAcknowledged(scope, statuses)
	expect(values).not.toHaveBeenCalled()

	using acknowledged = collect('ydb:topic.writer.acknowledged')
	publishAcknowledged(scope, statuses)
	expect(values).toHaveBeenCalledOnce()
	expect(acknowledged.payloads).toEqual([{ ...scope, written: 2, skipped: 1, writtenInTx: 1 }])
})

test('emits a flush tracing span', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	using flush = collectTrace('tracing:ydb:topic.writer.flush')
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	let flushed = writer.flush()
	await nextRequest(stream.requests, 'writeRequest')
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await flushed
	expect(flush.counts.start).toBe(1)
	expect(flush.counts.asyncEnd).toBe(1)
})

test('invokes the onAck callback for every acknowledged message', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	let acked: Array<[bigint, string]> = []
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: (seqNo, status) => acked.push([seqNo, status]),
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	writer.write(bytes(2))
	await nextRequest(stream.requests, 'writeRequest')

	stream.responses.push(writeResponse([{ seqNo: 1n, status: 'written' }]))
	stream.responses.push(writeResponse([{ seqNo: 2n, status: 'skipped' }]))
	await writer.flush(tc.signal)

	expect(acked).toEqual([
		[1n, 'written'],
		[2n, 'skipped'],
	])
})

test('surfaces a non-retryable failure during connect as a terminal error', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')

	writer.write(bytes(1))
	let flushed = writer.flush()
	stream.responses.push(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(flushed).rejects.toBeDefined()
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('keeps draining a graceful close across a mid-close reconnect', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(first.requests, 'writeRequest')

	let closed = false
	let closing = writer.close().then(() => (closed = true))
	first.responses.close()

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	second.responses.push(initResponse(0n))

	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages[0]!.seqNo).toBe(1n)
	second.responses.push(writeResponse([{ seqNo: 1n }]))

	await closing
	expect(closed).toBe(true)
})

test('publishes a reconnecting diagnostics event on a retryable disconnect', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	using reconnects = collect<{ attempt: number }>('ydb:topic.writer.reconnecting')
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	first.responses.close()

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	second.responses.push(initResponse(0n))

	expect(reconnects.payloads.length).toBeGreaterThanOrEqual(1)
	await writer.close(tc.signal)
})

test('closes gracefully via async disposal', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	let disposed = false
	let disposing = writer[Symbol.asyncDispose]().then(() => {
		disposed = true
		return undefined
	})

	expect(disposed).toBe(false)
	expect(stream.signal.aborted).toBe(false)

	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await disposing

	expect(disposed).toBe(true)
	await expect.poll(() => stream.signal.aborted).toBe(true)
	expect(() => writer.write(bytes(2))).toThrow(/closed/)
	await writer.close()
})

test('tags writes with the transaction identity', async (tc) => {
	let received = Promise.withResolvers<StreamWriteMessage_WriteRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					yield initResponse(0n)
				}
				if (message.case === 'writeRequest') {
					received.resolve(message.value)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let { tx } = makeFakeTx()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', tx })
	writer.write(bytes(1))
	await writer.flush(tc.signal)
	let request = await received.promise
	expect(request.tx?.id).toBe('tx-1')
	expect(request.tx?.session).toBe('tx-session')
})

test('reconnects after a mid-stream network error', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(first.requests, 'writeRequest')
	first.responses.fail(new RpcError(Status.UNAVAILABLE, 'Connection lost'))

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	second.responses.push(initResponse(0n))

	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages[0]!.seqNo).toBe(1n)

	let flushed = writer.flush()
	second.responses.push(writeResponse([{ seqNo: 1n }]))
	await expect(flushed).resolves.toBe(1n)
})

test('tears down the underlying stream on destroy', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.destroy()

	await expect.poll(() => stream.signal.aborted).toBe(true)
})

test('tears down the underlying stream after a graceful close', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	let closing = writer.close()
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await closing

	await expect.poll(() => stream.signal.aborted).toBe(true)
})

test('rejects writes and flushes after close, and a second close is a no-op', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	await writer.close()

	expect(() => writer.write(bytes(1))).toThrow(/closed/)
	await expect(writer.flush()).rejects.toBeDefined()
	await writer.close()
})
test('compresses the payload with a non-RAW codec and reports the uncompressed size', async (tc) => {
	let received = Promise.withResolvers<StreamWriteMessage_WriteRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					yield initResponse(0n)
				}
				if (message.case === 'writeRequest') {
					received.resolve(message.value)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })
	let raw = new Uint8Array(1000).fill(65)
	writer.write(raw)
	await writer.flush(tc.signal)
	let request = await received.promise
	expect(request.codec).toBe(Codec.GZIP)
	let message = request.messages[0]!
	expect(message.data.length).toBeLessThan(raw.length)
	expect(message.uncompressedSize).toBe(1000n)
})

test('throws on write() issued during a graceful close', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	let closing = writer.close()
	expect(() => writer.write(bytes(2))).toThrow(/closed/)

	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await closing
})

test('rejects close() when the drain fails terminally (no silent data loss)', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	let closing = writer.close()
	stream.responses.push(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(closing).rejects.toBeDefined()
})

test('rejects mixing partitionId and messageGroupId', async () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	expect(() =>
		createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			partitionId: 0n,
			messageGroupId: 'g',
		})
	).toThrow(/mutually exclusive/)
})

test('resends unacked manual-seqNo messages after a reconnect', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1), { seqNo: 10n })
	writer.write(bytes(2), { seqNo: 20n })
	await nextRequest(first.requests, 'writeRequest')
	first.responses.push(writeResponse([{ seqNo: 10n }]))

	first.responses.close()

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	second.responses.push(initResponse(10n))
	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages.map((m) => m.seqNo)).toEqual([20n])
})

test('holds the closing drain until init recovers the seqNo high-water mark', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	let acked: Array<{ seqNo: bigint; status: string }> = []
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: (seqNo, status) => acked.push({ seqNo, status: status ?? 'unknown' }),
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	let init = await nextRequest(stream.requests, 'initRequest')
	expect(init.getLastSeqNo).toBe(true)
	writer.write(bytes(1, 2, 3))
	let closed = writer.close()
	let receivedWrite = false
	let pendingWrite = nextRequest(stream.requests, 'writeRequest').then((request) => {
		receivedWrite = true
		return request
	})
	await tick()
	expect(receivedWrite).toBe(false)
	stream.responses.push(initResponse(100n))
	let writeReq = await pendingWrite
	expect(writeReq.messages.map((m) => m.seqNo)).toEqual([101n])
	stream.responses.push(writeResponse([{ seqNo: 101n }]))
	await expect(closed).resolves.toBeUndefined()
	expect(acked).toEqual([{ seqNo: 101n, status: 'written' }])
})

test('rejects close and flush when the gated drain times out before any init', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		gracefulShutdownTimeoutMs: 30,
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')

	let pendingWrite = nextRequest(stream.requests, 'writeRequest')
	void pendingWrite.catch(() => {})
	writer.write(bytes(1))
	let flushed = writer.flush()
	let closed = writer.close()
	void flushed.catch(() => {})

	await expect(closed).rejects.toThrow(/undelivered/i)
	await expect(flushed).rejects.toBeDefined()
	await expect(pendingWrite).rejects.toBeDefined()
	await expect(writer.close()).rejects.toThrow(/undelivered/i)
})

test('invokes onAck for messages acknowledged during graceful close', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using acknowledged = collect('ydb:topic.writer.acknowledged')

	let acked: bigint[] = []
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: (seqNo) => acked.push(seqNo),
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	writer.write(bytes(2))
	let closed = writer.close()

	let request = await nextRequest(stream.requests, 'writeRequest')
	let seqNos = request.messages.map((message) => message.seqNo)
	expect(seqNos).toEqual([1n, 2n])
	stream.responses.push(writeResponse([{ seqNo: 1n }, { seqNo: 2n }]))
	await closed

	expect(acked).toEqual([1n, 2n])
	expect(acknowledged.payloads.length).toBeGreaterThan(0)
})

test('invokes onAck exactly once per message across a mid-close reconnect drain', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	let acked: Array<{ seqNo: bigint; status: string }> = []
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: (seqNo, status) => acked.push({ seqNo, status: String(status) }),
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	writer.write(bytes(2))

	await nextRequest(stream.requests, 'writeRequest')

	let closed = writer.close()
	stream.responses.close()
	let stream2: WriteStream = (await streams.take(tc.signal)).value
	let init2 = await nextRequest(stream2.requests, 'initRequest')
	expect(init2.getLastSeqNo).toBe(false) // mark already recovered — never re-request
	stream2.responses.push(initResponse(1n))
	let resend = await nextRequest(stream2.requests, 'writeRequest')
	expect(resend.messages.map((m) => m.seqNo)).toEqual([2n])

	stream2.responses.push(writeResponse([{ seqNo: 2n }]))
	await tick()
	await closed

	expect(acked.map((a) => a.seqNo)).toEqual([1n, 2n])
	expect(acked[0]!.status).toBe('skipped') // dedup-recovered
	expect(acked[1]!.status).toBe('written')
	expect(new Set(acked.map((a) => a.seqNo)).size).toBe(acked.length)
})

test('resolves a pending flush when close drains the buffer successfully', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))

	let flushed = writer.flush()
	let closed = writer.close()

	let request = await nextRequest(stream.requests, 'writeRequest')
	let seqNos = request.messages.map((message) => message.seqNo)
	expect(seqNos).toEqual([1n])
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await closed // graceful close succeeded — the buffer fully drained

	await expect(flushed).resolves.toBe(1n)
})

test('resolves a flush issued after close() once the closing drain completes', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))

	let closed = writer.close()

	let flushed = writer.flush() // issued while the FSM is already in 'closing'

	let request = await nextRequest(stream.requests, 'writeRequest')
	let seqNos = request.messages.map((message) => message.seqNo)
	expect(seqNos).toEqual([1n])
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await closed
	await expect(flushed).resolves.toBe(1n)
})

test('renders the tx distinction in the inspect tag', () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	let fake = makeFakeTx()
	using plain = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	using tx = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	expect(Object.prototype.toString.call(plain)).toBe('[object TopicWriter]')
	expect(Object.prototype.toString.call(tx)).toBe('[object TopicTxWriter]')
})

test('flushes and closes when the transaction commits', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	let init = await nextRequest(stream.requests, 'initRequest')
	expect(init.producerId).toBe('p')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')
	let committed = fake.commit()
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await committed

	expect(() => writer.write(bytes(2))).toThrow(/closed/)
})

test('destroys the writer when the transaction rolls back', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))

	await fake.rollback(new Error('boom'))

	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
	await expect.poll(() => stream.signal.aborted).toBe(true)
})

test('destroys the writer when the transaction closes without commit', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))

	await fake.close(false)

	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('keeps running when the transaction closes after commit', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))
	await fake.close(true)

	expect(() => writer.write(bytes(1))).not.toThrow()
})

test('rejects a pending flush when the caller aborts the signal', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')
	let ac = new AbortController()
	let flushed = writer.flush(ac.signal)
	ac.abort(new Error('caller cancelled'))

	await expect(flushed).rejects.toThrow('caller cancelled')
})

test('rejects a flush immediately when the signal is already aborted', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	let ac = new AbortController()
	ac.abort(new Error('already gone'))

	await expect(writer.flush(ac.signal)).rejects.toThrow('already gone')
})

test('rejects a close when the caller aborts the signal', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')
	let ac = new AbortController()
	let closing = writer.close(ac.signal)
	ac.abort(new Error('shutdown cancelled'))

	await expect(closing).rejects.toThrow('shutdown cancelled')
})

test('ignores destroy after a graceful close', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	await writer.close()
	expect(() => writer.destroy()).not.toThrow()
	expect(() => writer.destroy(new Error('x'))).not.toThrow()
})

test('rejects writes and flushes after destroy', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.destroy(new Error('stopped'))

	expect(() => writer.write(bytes(1))).toThrow(/failed|closed/)
	await expect(writer.flush()).rejects.toBeDefined()
	expect(() => writer.destroy()).not.toThrow()
})

test('rethrows and destroys on async disposal when the drain fails', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')
	let disposing = writer[Symbol.asyncDispose]()
	stream.responses.push(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(disposing).rejects.toBeDefined()
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})
test('coalesces update-token requests until one is acknowledged', async (tc) => {
	let tokens: string[] = []
	let firstToken = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') yield initResponse(0n)
				if (message.case === 'updateTokenRequest') {
					tokens.push(message.value.token)
					firstToken.resolve()
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		updateTokenIntervalMs: 5,
	})
	await firstToken.promise
	await new Promise((resolve) => setTimeout(resolve, 60))
	expect(tokens).toHaveLength(1)
	await writer.close(tc.signal)
})

test('keeps a later flush pending until its preceding write is acknowledged', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))

	let first = writer.flush()
	writer.write(bytes(1))
	let completed = false
	let second = writer.flush().then((seqNo) => {
		completed = true
		return seqNo
	})
	await expect(first).resolves.toBe(0n)

	let request = await nextRequest(stream.requests, 'writeRequest')
	let seqNos = request.messages.map((message) => message.seqNo)
	expect(seqNos).toEqual([1n])
	expect(completed).toBe(false)
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await expect(second).resolves.toBe(1n)
})

test('rejects an invalid date before accepting the write and remains usable', async (tc) => {
	let received = Promise.withResolvers<StreamWriteMessage_WriteRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					yield initResponse(0n)
				}
				if (message.case === 'writeRequest') {
					received.resolve(message.value)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let invalidDateOptions = { createdAt: new Date(NaN), seqNo: 10n }
	expect(() => writer.write(bytes(1), invalidDateOptions)).toThrow(/valid date/)
	writer.write(bytes(2))
	let flushed = writer.flush(tc.signal)
	let request = await received.promise
	expect(request.messages[0]!.seqNo).toBe(1n)
	await expect(flushed).resolves.toBe(1n)
})

test('charges payload and metadata bytes and restores capacity after acknowledgment', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', maxBufferBytes: 211n })
	let metadataItems = { trace: new Uint8Array(100) }
	writer.write(bytes(), { metadataItems })
	writer.write(bytes(1), { metadataItems })
	writer.write(bytes())
	expect(() => writer.write(bytes(2))).toThrow(/buffer is full/)
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))
	let flushed = writer.flush()
	let request = await nextRequest(stream.requests, 'writeRequest')
	let payloadSizes = request.messages.map((message) => message.data.length)
	expect(payloadSizes).toEqual([0, 1, 0])
	stream.responses.push(writeResponse([{ seqNo: 1n }, { seqNo: 2n }, { seqNo: 3n }]))
	await flushed
	expect(() => writer.write(bytes(3), { metadataItems })).not.toThrow()
})

test('reserves compressed payload bytes together with metadata', async (tc) => {
	let received = Promise.withResolvers<StreamWriteMessage_WriteRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					yield initResponse(0n)
				}
				if (message.case === 'writeRequest') {
					received.resolve(message.value)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let payload = new Uint8Array(1024)
	let compressedSize = GZIP_CODEC.compress(payload).byteLength
	let metadataItems = { trace: bytes(7) }
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		codec: GZIP_CODEC,
		maxBufferBytes: BigInt(compressedSize + 6),
	})
	writer.write(payload, { metadataItems })
	expect(() => writer.write(payload, { metadataItems })).toThrow(/buffer is full/)
	await writer.flush(tc.signal)
	let request = await received.promise
	let message = request.messages[0]!
	expect(message.uncompressedSize).toBe(1024n)
	expect(message.data.byteLength).toBe(compressedSize)
})

test('restores payload and metadata budget when reconnect initialization acknowledges a message', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', maxBufferBytes: 106n })
	let metadataItems = { trace: new Uint8Array(100) }
	let first: WriteStream = (await streams.take(tc.signal)).value
	first.responses.push(initResponse(0n))
	writer.write(bytes(1), { metadataItems })
	await nextRequest(first.requests, 'writeRequest')
	expect(() => writer.write(bytes(2), { metadataItems })).toThrow(/buffer is full/)
	let flushed = writer.flush()
	first.responses.close()
	let second: WriteStream = (await streams.take(tc.signal)).value
	second.responses.push(initResponse(1n))
	await expect(flushed).resolves.toBe(1n)
	expect(() => writer.write(bytes(2), { metadataItems })).not.toThrow()
})

test.for([
	{ name: 'ASCII', sizes: [['trace', 4091]] },
	{ name: 'UTF-8', sizes: [['ключ', 4088]] },
	{
		name: 'multiple',
		sizes: [
			['a', 2047],
			['b', 2047],
		],
	},
] satisfies { name: string; sizes: [string, number][] }[])(
	'validates the 4096-byte metadata limit with $name keys before admission',
	async ({ sizes }, tc) => {
		let streams = new AsyncQueue<WriteStream>()
		using server = new Server()
		server.add(TopicServiceDefinition, {
			async *streamWrite(input, { signal }) {
				using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
				streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
				signal.addEventListener('abort', () => responses.close(), { once: true })
				yield* responses
			},
		})
		let port = await server.listen('127.0.0.1:0')
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.enable_discovery': false,
		})
		using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
		let payload = bytes(1)
		let metadataItems = Object.fromEntries(
			sizes.map(([key, size]) => [key, new Uint8Array(size)])
		)
		let [lastKey, lastSize] = sizes.at(-1)!
		let oversized = { ...metadataItems, [lastKey]: new Uint8Array(lastSize + 1) }
		let invalidMetadataOptions = { seqNo: 99n, metadataItems: oversized }
		{
			using copies = vi.spyOn(globalThis, 'Uint8Array')
			expect(() => writer.write(payload, invalidMetadataOptions)).toThrow(/metadata.*4096/)
			expect(copies).not.toHaveBeenCalled()
		}

		writer.write(payload, { metadataItems })
		let stream: WriteStream = (await streams.take(tc.signal)).value
		stream.responses.push(initResponse(0n))
		let request = await nextRequest(stream.requests, 'writeRequest')
		let message = request.messages[0]!
		expect(message.seqNo).toBe(1n)
		let receivedMetadata = message.metadataItems.map(({ key, value }) => ({
			key,
			value: [...value],
		}))
		let expectedMetadata = Object.entries(metadataItems).map(([key, value]) => ({
			key,
			value: [...value],
		}))
		expect(receivedMetadata).toEqual(expectedMetadata)
	}
)

test('keeps auto numbering available after rejecting a metadata reservation', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', maxBufferBytes: 1n })
	let payload = bytes(1)
	let metadataItems = { tag: bytes(2) }
	{
		using copies = vi.spyOn(globalThis, 'Uint8Array')
		expect(() => writer.write(payload, { seqNo: 99n, metadataItems })).toThrow(/buffer is full/)
		expect(copies).not.toHaveBeenCalled()
	}

	writer.write(payload)
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))
	let request = await nextRequest(stream.requests, 'writeRequest')
	expect(request.messages[0]!.seqNo).toBe(1n)
})

test.for([0n, -1n, 1n << 63n])(
	'keeps auto numbering available after rejecting seqNo %s',
	async (seqNo, tc) => {
		let streams = new AsyncQueue<WriteStream>()
		using server = new Server()
		server.add(TopicServiceDefinition, {
			async *streamWrite(input, { signal }) {
				using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
				streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
				signal.addEventListener('abort', () => responses.close(), { once: true })
				yield* responses
			},
		})
		let port = await server.listen('127.0.0.1:0')
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.enable_discovery': false,
		})
		using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
		expect(() => writer.write(bytes(1), { seqNo })).toThrow(/positive int64/)
		writer.write(bytes(2))
		let stream: WriteStream = (await streams.take(tc.signal)).value
		stream.responses.push(initResponse(0n))
		let request = await nextRequest(stream.requests, 'writeRequest')
		expect(request.messages[0]!.seqNo).toBe(1n)
	}
)

test('retains falsy destruction reasons on close and flush', async () => {
	await Promise.all(
		[0, false, ''].map(async (reason) => {
			using driver = new Driver('grpc://127.0.0.1:1/local', {
				'ydb.sdk.enable_discovery': false,
			})
			using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
			writer.write(bytes(1))
			writer.destroy(reason)
			await expect(writer.flush()).rejects.toBe(reason)
			await expect(writer.close()).rejects.toBe(reason)
		})
	)
})

test('sends full in-flight windows without waiting for the flush interval', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		maxInflightCount: 1,
		flushIntervalMs: 2_147_483_647,
	})
	writer.write(bytes(1))
	writer.write(bytes(2))
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))
	let first = await nextRequest(stream.requests, 'writeRequest')
	expect(first.messages.map((message) => message.seqNo)).toEqual([1n])
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	let second = await nextRequest(stream.requests, 'writeRequest')
	expect(second.messages.map((message) => message.seqNo)).toEqual([2n])
	stream.responses.push(writeResponse([{ seqNo: 2n }]))
	await writer.flush(tc.signal)
	writer.write(bytes(3))
	let third = await nextRequest(stream.requests, 'writeRequest')
	expect(third.messages.map((message) => message.seqNo)).toEqual([3n])
})

test.for(['before', 'after'])(
	'preserves manual flush results when the first write arrives %s init',
	async (timing, tc) => {
		let streams = new AsyncQueue<WriteStream>()
		using server = new Server()
		server.add(TopicServiceDefinition, {
			async *streamWrite(input, { signal }) {
				using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
				streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
				signal.addEventListener('abort', () => responses.close(), { once: true })
				yield* responses
			},
		})
		let port = await server.listen('127.0.0.1:0')
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.enable_discovery': false,
		})
		using sessions = collect('ydb:topic.writer.session.started')
		let acknowledged: Array<[bigint, string]> = []
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			onAck: (seqNo, status) => acknowledged.push([seqNo, status]),
		})
		let first: WriteStream = (await streams.take(tc.signal)).value
		await nextRequest(first.requests, 'initRequest')
		if (timing === 'before') {
			writer.write(bytes(1), { seqNo: 1n })
		}
		first.responses.push(initResponse(100n))

		await expect.poll(() => sessions.payloads.length).toBe(1)
		if (timing === 'after') {
			writer.write(bytes(1), { seqNo: 1n })
		}
		let request = await nextRequest(first.requests, 'writeRequest')
		expect(request.messages.map((message) => message.seqNo)).toEqual([1n])
		let flushed = writer.flush()
		first.responses.close()
		let second: WriteStream = (await streams.take(tc.signal)).value
		second.responses.push(initResponse(100n))
		await expect(flushed).resolves.toBe(1n)
		expect(acknowledged).toEqual([[1n, 'skipped']])
		writer.write(bytes(2), { seqNo: 2n })
		let next = await nextRequest(second.requests, 'writeRequest')
		expect(next.messages.map((message) => message.seqNo)).toEqual([2n])
		let nextFlush = writer.flush()
		second.responses.push(writeResponse([{ seqNo: 2n, status: 'skipped' }]))
		await expect(nextFlush).resolves.toBe(2n)
	}
)

test('waits for every reconnect init before sending a closing drain', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let first: WriteStream = (await streams.take(tc.signal)).value
	first.responses.push(initResponse(0n))
	writer.write(bytes(1))
	let flushed = writer.flush()
	await nextRequest(first.requests, 'writeRequest')
	first.responses.push(writeResponse([{ seqNo: 1n }]))
	await flushed
	first.responses.close()

	writer.write(bytes(2))
	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	let closed = writer.close()
	void closed.catch(() => {})
	let receivedWrite = false
	let pendingWrite = nextRequest(second.requests, 'writeRequest').then((request) => {
		receivedWrite = true
		return request
	})
	await tick()
	expect(receivedWrite).toBe(false)
	second.responses.push(initResponse(1n))
	let request = await pendingWrite
	expect(request.messages.map((message) => message.seqNo)).toEqual([2n])
	second.responses.push(writeResponse([{ seqNo: 2n }]))
	await closed
})

test('sends a count-full batch before the interval expires', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using sessions = collect('ydb:topic.writer.session.started')
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		maxInflightCount: 2,
		flushIntervalMs: 60_000,
	})
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))
	await expect.poll(() => sessions.payloads.length).toBe(1)

	writer.write(bytes(1))
	let receivedWrite = false
	let pendingWrite = nextRequest(stream.requests, 'writeRequest').then((request) => {
		receivedWrite = true
		return request
	})
	await tick()
	expect(receivedWrite).toBe(false)
	writer.write(bytes(2))
	let request = await pendingWrite
	expect(request.messages.map((message) => message.seqNo)).toEqual([1n, 2n])
})

test('sends a byte-full batch when the next message cannot fit', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using sessions = collect('ydb:topic.writer.session.started')
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		flushIntervalMs: 60_000,
	})
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))
	await expect.poll(() => sessions.payloads.length).toBe(1)
	writer.write(new Uint8Array(25 * 1024 * 1024))
	let receivedWrite = false
	let pendingWrite = nextRequest(stream.requests, 'writeRequest').then((request) => {
		receivedWrite = true
		return request
	})
	await tick()
	expect(receivedWrite).toBe(false)
	writer.write(new Uint8Array(25 * 1024 * 1024))
	let request = await pendingWrite
	expect(request.messages.map((message) => message.seqNo)).toEqual([1n])
	let receivedSecond = false
	let pendingSecond = nextRequest(stream.requests, 'writeRequest').then((next) => {
		receivedSecond = true
		return next
	})
	await tick()
	expect(receivedSecond).toBe(false)
	let flushed = writer.flush(tc.signal)
	let second = await pendingSecond
	expect(second.messages.map((message) => message.seqNo)).toEqual([2n])
	stream.responses.push(writeResponse([{ seqNo: 1n }, { seqNo: 2n }]))
	await flushed
})

test('flush and close send a partial batch without waiting for its interval', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		flushIntervalMs: 60_000,
	})
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	let flushed = writer.flush()
	let first = await nextRequest(stream.requests, 'writeRequest')
	expect(first.messages.map((message) => message.seqNo)).toEqual([1n])
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await expect(flushed).resolves.toBe(1n)
	writer.write(bytes(2))
	let closed = writer.close()
	let second = await nextRequest(stream.requests, 'writeRequest')
	expect(second.messages.map((message) => message.seqNo)).toEqual([2n])
	stream.responses.push(writeResponse([{ seqNo: 2n }]))
	await closed
})

test('handles a rejected async onAck without delaying flush', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let observer = Promise.withResolvers<void>()
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: async () => {
			await observer.promise
			throw new Error('Asynchronous ACK observer failed')
		},
	})
	writer.write(bytes(1))
	let flushed = writer.flush()
	let stream: WriteStream = (await streams.take(tc.signal)).value
	stream.responses.push(initResponse(0n))
	await nextRequest(stream.requests, 'writeRequest')
	stream.responses.push(writeResponse([{ seqNo: 1n }]))
	await expect(flushed).resolves.toBe(1n)
	observer.resolve()
	await new Promise<void>((resolve) => setImmediate(resolve))
	await expect(writer.close()).resolves.toBeUndefined()
})
test.for([
	{ mode: 'auto', recovery: 'ack' },
	{ mode: 'auto', recovery: 'resend' },
	{ mode: 'auto', recovery: 'dedup' },
	{ mode: 'manual', recovery: 'ack' },
	{ mode: 'manual', recovery: 'resend' },
	{ mode: 'manual', recovery: 'dedup' },
])(
	'settles each flush at its captured write boundary ($mode, $recovery)',
	async ({ mode, recovery }, tc) => {
		let streams = new AsyncQueue<WriteStream>()
		using server = new Server()
		server.add(TopicServiceDefinition, {
			async *streamWrite(input, { signal }) {
				using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
				streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
				signal.addEventListener('abort', () => responses.close(), { once: true })
				yield* responses
			},
		})
		let port = await server.listen('127.0.0.1:0')
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.enable_discovery': false,
		})
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			maxInflightCount: 3,
		})
		let seq: [bigint, bigint, bigint] = mode === 'manual' ? [10n, 20n, 30n] : [1n, 2n, 3n]
		writer.write(bytes(1), mode === 'manual' ? { seqNo: seq[0] } : undefined)
		let firstDone = false
		let first = writer.flush(tc.signal).then((seqNo) => {
			firstDone = true
			return seqNo
		})
		let sameBoundary = writer.flush(tc.signal)
		writer.write(bytes(2), mode === 'manual' ? { seqNo: seq[1] } : undefined)
		let secondDone = false
		let second = writer.flush(tc.signal).then((seqNo) => {
			secondDone = true
			return seqNo
		})
		writer.write(bytes(3), mode === 'manual' ? { seqNo: seq[2] } : undefined)

		let stream: WriteStream = (await streams.take(tc.signal)).value
		await nextRequest(stream.requests, 'initRequest')
		stream.responses.push(initResponse(0n))
		await nextRequest(stream.requests, 'writeRequest')

		if (recovery !== 'ack') {
			stream.responses.close()
			stream = (await streams.take(tc.signal)).value
			await nextRequest(stream.requests, 'initRequest')
			stream.responses.push(initResponse(recovery === 'dedup' ? seq[0] : 0n))
			await nextRequest(stream.requests, 'writeRequest')
		}
		if (recovery !== 'dedup') {
			stream.responses.push(writeResponse([{ seqNo: seq[0] }]))
		}
		await first

		expect(firstDone).toBe(true)
		expect(secondDone).toBe(false)
		await expect(first).resolves.toBe(seq[0])
		await expect(sameBoundary).resolves.toBe(seq[0])

		stream.responses.push(writeResponse([{ seqNo: seq[1] }]))
		await expect(second).resolves.toBe(seq[1])
		let thirdDone = false
		let third = writer.flush(tc.signal).then((seqNo) => {
			thirdDone = true
			return seqNo
		})

		expect(thirdDone).toBe(false)
		stream.responses.push(writeResponse([{ seqNo: seq[2] }]))
		await expect(third).resolves.toBe(seq[2])
		await writer.close()
	}
)
