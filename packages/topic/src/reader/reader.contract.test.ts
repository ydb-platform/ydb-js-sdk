import { create } from '@bufbuild/protobuf'
import { DurationSchema, TimestampSchema } from '@bufbuild/protobuf/wkt'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { once } from 'node:events'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	type StreamReadMessage_CommitOffsetRequest,
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromServerSchema,
	type StreamReadMessage_InitRequest,
	type StreamReadMessage_StartPartitionSessionResponse,
	TopicServiceDefinition,
	type UpdateOffsetsInTransactionRequest,
	UpdateOffsetsInTransactionResponseSchema,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { abortable } from '@ydbjs/abortable'
import { YDBError } from '@ydbjs/error'
import { RpcError, Server, Status } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import { ZSTD_CODEC } from '../codec.ts'
import type { TopicMessage } from '../message.ts'
import { TopicReader, createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	failureResponse,
	initResponse,
	makeFakeTx,
	readResponse,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'

let bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
let text = (payload: Uint8Array): string => new TextDecoder().decode(payload)

function capture<T>(name: string): { payloads: T[] } & Disposable {
	let payloads: T[] = []
	let receive = (message: unknown) => payloads.push(message as T)
	subscribe(name, receive)
	return {
		payloads,
		[Symbol.dispose]() {
			unsubscribe(name, receive)
		},
	}
}

async function collect(
	reader: TopicReader,
	count: number,
	signal: AbortSignal
): Promise<TopicMessage[]> {
	let messages: TopicMessage[] = []
	for await (let batch of reader.read({ batchWindowMs: 5, signal })) {
		messages.push(...batch)
		if (messages.length >= count) break
	}
	return messages
}

test.for([0n, -1n])('rejects an unusable read-credit window of %s bytes', (maxBufferBytes) => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	let createReader = () => new TopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes })
	expect(createReader).toThrow(/maxBufferBytes must be positive/)
})

test('requests the full buffer as read credit after init', async () => {
	let observed = Promise.withResolvers<{ consumer: string; bytes: bigint }>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let consumer = ''
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					consumer = request.value.consumer
					yield initResponse()
				}
				if (request.case === 'readRequest')
					observed.resolve({ consumer, bytes: request.value.bytesSize })
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes: 4096n })
	let request = await observed.promise
	expect(request.consumer).toBe('c')
	expect(request.bytes).toBe(4096n)
	await reader.close()
})

test('acknowledges a started partition session with its id', async () => {
	let started = Promise.withResolvers<bigint>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') yield initResponse()
				if (request.case === 'readRequest')
					yield startPartitionSession({ partitionSessionId: 7n, partitionId: 3n })
				if (request.case === 'startPartitionSessionResponse')
					started.resolve(request.value.partitionSessionId)
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	expect(await started.promise).toBe(7n)
	await reader.close()
})

test('surfaces decoded messages through read()', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
							{ offset: 2n, seqNo: 3n, data: bytes('c') },
						],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 3, tc.signal)
	let payloads = messages.map((message) => text(message.payload))
	let offsets = messages.map((message) => message.offset)
	expect(payloads).toEqual(['a', 'b', 'c'])
	expect(offsets).toEqual([0n, 1n, 2n])
})

test('honors the deprecated waitMs alias for batchWindowMs', async (tc) => {
	let ready = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') yield initResponse()
				if (request.case === 'readRequest') ready.resolve()
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	await ready.promise
	let iterator = reader.read({ waitMs: 10, signal: tc.signal })[Symbol.asyncIterator]()
	let first = await iterator.next()
	expect(first.done).toBe(false)
	expect(first.value).toEqual([])
	await iterator.return?.()
})

test('resolves commit() when the server acknowledges the offset', async (tc) => {
	let observed = Promise.withResolvers<StreamReadMessage_CommitOffsetRequest>()
	let acknowledge = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
					})
				if (request.case === 'commitOffsetRequest') {
					observed.resolve(request.value)
					await abortable(context.signal, acknowledge.promise)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }])
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let [message] = await collect(reader, 1, tc.signal)
	let commit = reader.commit(message!)
	let request = await observed.promise
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(1n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(1n)
	acknowledge.resolve()
	await expect(commit).resolves.toBeUndefined()
})

test.for([
	{ name: 'clean end', error: undefined },
	{ name: 'server deadline', error: new RpcError(Status.DEADLINE_EXCEEDED, 'deadline') },
	{ name: 'server timeout', error: new YDBError(StatusIds_StatusCode.TIMEOUT, []) },
	{ name: 'expired session', error: new YDBError(StatusIds_StatusCode.SESSION_EXPIRED, []) },
	{ name: 'indeterminate result', error: new YDBError(StatusIds_StatusCode.UNDETERMINED, []) },
])('preserves the pending commit across $name', async ({ error }, tc) => {
	let streams = 0
	let resent = Promise.withResolvers<StreamReadMessage_CommitOffsetRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let id = BigInt(++streams)
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse(`session-${id}`)
					yield startPartitionSession({ partitionSessionId: id, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse' && id === 1n)
					yield readResponse({
						partitionSessionId: id,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
							{ offset: 2n, seqNo: 3n, data: bytes('c') },
						],
					})
				if (request.case === 'commitOffsetRequest') {
					if (id === 1n) {
						if (error instanceof YDBError) {
							yield failureResponse(error.code)
							if (!context.signal.aborted) await once(context.signal, 'abort')
							continue
						}
						if (error) throw error
						return
					}
					resent.resolve(request.value)
					yield commitOffsetResponse([{ partitionSessionId: id, committedOffset: 3n }])
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 3, tc.signal)
	let commit = reader.commit(messages[2]!)
	let request = await resent.promise
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(2n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(3n)
	await expect(commit).resolves.toBeUndefined()
})

test('a tx reader binds offsets read across a reconnect to the transaction commit', async (tc) => {
	let offsets: UpdateOffsetsInTransactionRequest[] = []
	let reconnect = Promise.withResolvers<void>()
	let streams = 0
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let id = BigInt(++streams)
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse(`session-${id}`)
					yield startPartitionSession({
						partitionSessionId: id,
						partitionId: 10n,
						committedOffset: id === 1n ? 0n : 5n,
					})
				}
				if (request.case === 'startPartitionSessionResponse') {
					let messages =
						id === 1n
							? [
									{ offset: 5n, seqNo: 1n, data: bytes('a') },
									{ offset: 6n, seqNo: 2n, data: bytes('b') },
								]
							: [{ offset: 7n, seqNo: 3n, data: bytes('c') }]
					yield readResponse({ partitionSessionId: id, messages })
					if (id === 1n) {
						await abortable(context.signal, reconnect.promise)
						return
					}
				}
			}
		},
		updateOffsetsInTransaction(request) {
			offsets.push(request)
			return create(UpdateOffsetsInTransactionResponseSchema, {
				operation: { ready: true, status: StatusIds_StatusCode.SUCCESS },
			})
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let transaction = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 2, tc.signal)
	reconnect.resolve()
	await collect(reader, 1, tc.signal)
	await transaction.commit(tc.signal)
	expect(offsets).toHaveLength(1)
	let request = offsets[0]!
	expect(request.consumer).toBe('c')
	expect(request.tx).toMatchObject({ id: 'tx-1', session: 'tx-session' })
	expect(request.topics).toHaveLength(1)
	expect(request.topics[0]!.partitions).toEqual([
		expect.objectContaining({
			partitionId: 10n,
			partitionOffsets: [expect.objectContaining({ start: 0n, end: 8n })],
		}),
	])
})

test('throws on a manual commit() from a tx reader', async (tc) => {
	let commits: unknown[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
					})
				if (request.case === 'commitOffsetRequest') commits.push(request.value)
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: makeFakeTx().tx })
	let [message] = await collect(reader, 1, tc.signal)
	let manualCommit = () => reader.commit(message!)
	expect(manualCommit).toThrow('Tx reader commits offsets via the transaction')
	await reader.close()
	expect(commits).toEqual([])
})

test('renders the tx distinction in the inspect tag', () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	using plain = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	using tx = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: makeFakeTx().tx })
	expect(Object.prototype.toString.call(plain)).toBe('[object TopicReader]')
	expect(Object.prototype.toString.call(tx)).toBe('[object TopicTxReader]')
})

test('reopens the stream after a transport drop', async () => {
	let streams = 0
	let firstSessionCount = 0
	let reopened = Promise.withResolvers<string>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let id = ++streams
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					if (id === 2) reopened.resolve(request.value.consumer)
					yield initResponse(`session-${id}`)
					yield startPartitionSession({
						partitionSessionId: BigInt(id),
						partitionId: 10n,
					})
				}
				if (request.case === 'startPartitionSessionResponse' && id === 1) {
					firstSessionCount = streams
					return
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	expect(await reopened.promise).toBe('c')
	expect(firstSessionCount).toBe(1)
	expect(streams).toBe(2)
	await reader.close()
})

test('fails terminally on a non-retryable status and rejects the pending commit', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
					})
				if (request.case === 'commitOffsetRequest')
					yield failureResponse(StatusIds_StatusCode.SCHEME_ERROR)
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let [message] = await collect(reader, 1, tc.signal)
	let commit = reader.commit(message!)
	await expect(commit).rejects.toThrow(YDBError)
	let closing = reader.close()
	await expect(closing).rejects.toThrow(YDBError)
})

test('read() throws the terminal error instead of ending cleanly', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') yield initResponse()
				if (request.case === 'readRequest')
					yield failureResponse(StatusIds_StatusCode.SCHEME_ERROR)
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let caught: unknown
	try {
		for await (let batch of reader.read({ signal: tc.signal })) void batch
	} catch (error) {
		caught = error
	}
	expect(caught).toBeInstanceOf(YDBError)
	expect((caught as YDBError).code).toBe(StatusIds_StatusCode.SCHEME_ERROR)
})

test('retryOnSchemeError keeps reconnecting on SCHEME_ERROR instead of terminating', async () => {
	let streams = 0
	let started = Promise.withResolvers<bigint>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let id = ++streams
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					if (id < 3) {
						yield failureResponse(StatusIds_StatusCode.SCHEME_ERROR)
						if (!context.signal.aborted) await once(context.signal, 'abort')
						continue
					}
					yield initResponse('session-C')
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					started.resolve(request.value.partitionSessionId)
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		retryOnSchemeError: true,
	})
	expect(await started.promise).toBe(1n)
	expect(streams).toBe(3)
	await reader.close()
})

test('replenishes read credit once the consumer drains a batch', async (tc) => {
	let credits: bigint[] = []
	let replenished = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'readRequest') {
					credits.push(request.value.bytesSize)
					if (credits.length === 2) replenished.resolve()
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 100n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('payload') }],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes: 100n })
	await expect.poll(() => reader.bufferedBytes).toBe(100n)
	expect(credits).toEqual([100n])
	await collect(reader, 1, tc.signal)
	await replenished.promise
	expect(credits).toEqual([100n, 100n])
})

test('reports buffered bytes and publishes every change', async (tc) => {
	using changes = capture<{ bufferedBytes: bigint; consumer: string; topics: string[] }>(
		'ydb:topic.reader.buffer.changed'
	)
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 300n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	await expect.poll(() => reader.bufferedBytes).toBe(300n)
	expect(changes.payloads.at(-1)).toMatchObject({
		bufferedBytes: 300n,
		consumer: 'c',
		topics: ['/t'],
	})
	let messages = await collect(reader, 1, tc.signal)
	expect(messages).toHaveLength(1)
	expect(reader.bufferedBytes).toBe(0n)
	expect(changes.payloads.at(-1)?.bufferedBytes).toBe(0n)
})

test('publishes session-started, partition-started, and committed diagnostics', async (tc) => {
	using sessions = capture<{ sessionId: string; consumer: string; topics: string[] }>(
		'ydb:topic.reader.session.started'
	)
	using started = capture<{ partitionId: bigint; committedOffset: bigint; topics: string[] }>(
		'ydb:topic.reader.partition.started'
	)
	using committed = capture<{ partitionId: bigint; committedOffset: bigint }>(
		'ydb:topic.reader.committed'
	)
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
					})
				if (request.case === 'commitOffsetRequest')
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }])
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 1, tc.signal)
	await reader.commit(messages)
	expect(sessions.payloads).toHaveLength(1)
	expect(sessions.payloads[0]).toMatchObject({ consumer: 'c', topics: ['/t'] })
	expect(sessions.payloads[0]!.sessionId.length).toBeGreaterThan(0)
	expect(started.payloads).toHaveLength(1)
	expect(started.payloads[0]!.partitionId).toBe(10n)
	expect(started.payloads[0]!.topics).toEqual(['/t'])
	expect(committed.payloads.at(-1)!.committedOffset).toBe(1n)
})

test('decodes a zstd-compressed batch delivered by the server', async (tc) => {
	let payload = bytes('zstd payload that must round-trip through decompression')
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						codec: Codec.ZSTD,
						messages: [{ offset: 0n, seqNo: 1n, data: ZSTD_CODEC.compress(payload) }],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let [message] = await collect(reader, 1, tc.signal)
	expect(text(message!.payload)).toBe(text(payload))
	expect(message!.codec).toBe(Codec.ZSTD)
})

test('sends only well-formed offset ranges when a message is committed twice', async (tc) => {
	let ranges: { start: bigint; end: bigint }[] = []
	let ended = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			try {
				for await (let { clientMessage: request } of requests) {
					if (request.case === 'initRequest') {
						yield initResponse()
						yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
					}
					if (request.case === 'startPartitionSessionResponse')
						yield readResponse({
							partitionSessionId: 1n,
							messages: [
								{ offset: 0n, seqNo: 1n, data: bytes('a') },
								{ offset: 1n, seqNo: 2n, data: bytes('b') },
								{ offset: 2n, seqNo: 3n, data: bytes('c') },
							],
						})
					if (request.case === 'commitOffsetRequest') {
						ranges.push(
							...request.value.commitOffsets.flatMap((partition) => partition.offsets)
						)
						yield commitOffsetResponse([
							{ partitionSessionId: 1n, committedOffset: 3n },
						])
					}
				}
			} finally {
				ended.resolve()
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 3, tc.signal)
	await reader.commit(messages)
	await reader.commit(messages[0]!)
	await reader.close()
	await ended.promise
	expect(ranges.length).toBeGreaterThan(0)
	for (let range of ranges) expect(range.start).toBeLessThan(range.end)
})

test('resolves a pending commit covered by stop_partition committed_offset', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
					})
				if (request.case === 'commitOffsetRequest')
					yield stopPartitionSession({
						partitionSessionId: 1n,
						graceful: false,
						committedOffset: 1n,
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 1, tc.signal)
	let commit = reader.commit(messages)
	await expect(commit).resolves.toBeUndefined()
})

test('sends a commit issued during a graceful stop and completes the handoff', async (tc) => {
	let commits: StreamReadMessage_FromClient['clientMessage'][] = []
	let stopResponses = 0
	let stopped = Promise.withResolvers<void>()
	let stopRequested = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
						],
					})
				if (request.case === 'commitOffsetRequest') {
					commits.push(request)
					if (commits.length === 1)
						yield stopPartitionSession({ partitionSessionId: 1n, graceful: true })
					else
						yield commitOffsetResponse([
							{ partitionSessionId: 1n, committedOffset: 2n },
						])
				}
				if (request.case === 'stopPartitionSessionResponse') {
					stopResponses++
					stopped.resolve()
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: async () => {
			stopRequested.resolve()
		},
	})
	let messages = await collect(reader, 2, tc.signal)
	let first = reader.commit(messages[0]!)
	await stopRequested.promise
	expect(commits).toHaveLength(1)
	let second = reader.commit(messages[1]!)
	await expect(first).resolves.toBeUndefined()
	await expect(second).resolves.toBeUndefined()
	await stopped.promise
	expect(commits).toHaveLength(2)
	expect(stopResponses).toBe(1)
})

test('drops buffered messages of a force-stopped partition and still releases their credit', async (tc) => {
	let credits: bigint[] = []
	let stop = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let replenished = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'readRequest') {
					credits.push(request.value.bytesSize)
					if (credits.length === 2) replenished.resolve()
				}
				if (request.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 400n,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
						],
					})
					await abortable(context.signal, stop.promise)
					yield stopPartitionSession({ partitionSessionId: 1n, graceful: false })
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
		onPartitionSessionStop: async () => {
			stopped.resolve()
		},
	})
	await expect.poll(() => reader.bufferedBytes).toBe(400n)
	stop.resolve()
	await stopped.promise
	let iterator = reader.read({ batchWindowMs: 50, signal: tc.signal })[Symbol.asyncIterator]()
	let delivered = await iterator.next()
	expect(delivered.value).toEqual([])
	await iterator.return?.()
	await replenished.promise
	expect(credits).toEqual([1000n, 400n])
})

test('rejects a commit for a batch yielded before its partition force-stopped', async (tc) => {
	let stop = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
					})
					await abortable(context.signal, stop.promise)
					yield stopPartitionSession({ partitionSessionId: 1n, graceful: false })
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: async () => {
			stopped.resolve()
		},
	})
	let [message] = await collect(reader, 1, tc.signal)
	stop.resolve()
	await stopped.promise
	let commit = reader.commit(message!)
	await expect(commit).rejects.toThrow('stopped or expired partition session')
})

test('invokes onPartitionSessionStop and keeps the reader alive on a force stop', async (tc) => {
	let stops: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse') {
					if (request.value.partitionSessionId === 1n) {
						yield stopPartitionSession({ partitionSessionId: 1n, graceful: false })
						yield startPartitionSession({ partitionSessionId: 2n, partitionId: 11n })
					} else
						yield readResponse({
							partitionSessionId: 2n,
							messages: [{ offset: 0n, seqNo: 1n, data: bytes('y') }],
						})
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: async (session) => {
			stops.push(session.partitionId)
		},
	})
	let messages = await collect(reader, 1, tc.signal)
	expect(stops).toEqual([10n])
	expect(messages).toHaveLength(1)
})

test('buffers a commit issued before the reconnected stream re-grants the partition', async (tc) => {
	let streams = 0
	let reconnect = Promise.withResolvers<void>()
	let reconnected = Promise.withResolvers<void>()
	let grant = Promise.withResolvers<void>()
	let sent: StreamReadMessage_FromClient[] = []
	let resent = Promise.withResolvers<bigint>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let id = BigInt(++streams)
			for await (let message of requests) {
				let request = message.clientMessage
				if (id === 2n) sent.push(message)
				if (request.case === 'initRequest') {
					yield initResponse(`session-${id}`)
					if (id === 1n)
						yield startPartitionSession({ partitionSessionId: id, partitionId: 10n })
				}
				if (request.case === 'readRequest' && id === 2n) {
					reconnected.resolve()
					await abortable(context.signal, grant.promise)
					yield startPartitionSession({ partitionSessionId: id, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse' && id === 1n) {
					yield readResponse({
						partitionSessionId: id,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
					})
					await abortable(context.signal, reconnect.promise)
					return
				}
				if (request.case === 'commitOffsetRequest') {
					resent.resolve(request.value.commitOffsets[0]!.partitionSessionId)
					yield commitOffsetResponse([{ partitionSessionId: id, committedOffset: 1n }])
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let [message] = await collect(reader, 1, tc.signal)
	reconnect.resolve()
	await reconnected.promise
	let commit = reader.commit(message!)
	grant.resolve()
	expect(await resent.promise).toBe(2n)
	await commit
	let order = sent.map((frame) => frame.clientMessage.case)
	let startIndex = order.indexOf('startPartitionSessionResponse')
	let commitIndex = order.indexOf('commitOffsetRequest')
	expect(startIndex).toBeGreaterThanOrEqual(0)
	expect(commitIndex).toBeGreaterThanOrEqual(0)
	expect(startIndex).toBeLessThan(commitIndex)
})

test('keeps the iterator alive past limit total messages (limit is a per-batch cap)', async (tc) => {
	let more = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
						],
					})
					await abortable(context.signal, more.promise)
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 2n, seqNo: 3n, data: bytes('c') }],
					})
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let batches = reader.read({ limit: 2, batchWindowMs: 5, signal: tc.signal })
	let iterator = batches[Symbol.asyncIterator]()
	let total = 0
	while (total < 2) {
		// oxlint-disable-next-line no-await-in-loop
		let batch = await iterator.next()
		expect(batch.done).toBe(false)
		total += batch.value!.length
	}
	let afterLimit = await iterator.next()
	expect(afterLimit.done).toBe(false)
	more.resolve()
	let messages: TopicMessage[] = []
	while (!messages.length) {
		// oxlint-disable-next-line no-await-in-loop
		let batch = await iterator.next()
		expect(batch.done).toBe(false)
		messages = batch.value!
	}
	expect(messages).toHaveLength(1)
	await iterator.return?.()
})

test('throws a single-consumer error on a second concurrent read()', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests)
				if (request.case === 'initRequest') yield initResponse()
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let first = reader.read({ batchWindowMs: 10, signal: tc.signal })[Symbol.asyncIterator]()
	await first.next()
	let second = reader.read({ batchWindowMs: 10, signal: tc.signal })[Symbol.asyncIterator]()
	let concurrent = second.next()
	await expect(concurrent).rejects.toThrow('read() is already in progress')
	await first.return?.()
})

test('delivers a message with codec UNSPECIFIED as a raw payload', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						codec: Codec.UNSPECIFIED,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('plain') }],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let [message] = await collect(reader, 1, tc.signal)
	expect(text(message!.payload)).toBe('plain')
})

test('fails the reader with an actionable error on an unknown codec', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						codec: Codec.LZOP,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('lzop-compressed-elsewhere') },
						],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let firstError: unknown
	try {
		await collect(reader, 1, tc.signal)
	} catch (error) {
		firstError = error
	}
	expect(String(firstError)).toContain('offset 0 of partition 10')
	expect(String(firstError)).toContain('codec 3')
	expect(String(firstError)).toContain('codecMap')
	expect(String((firstError as Error).cause)).toContain('Unsupported codec: 3')
	let anotherRead = collect(reader, 1, tc.signal)
	await expect(anotherRead).rejects.toBe(firstError)
	let closing = reader.close()
	await expect(closing).rejects.toThrow('offset 0 of partition 10')
})

test('decodes with a custom codecMap entry for a non-built-in codec', async (tc) => {
	let reverse = (payload: Uint8Array) => Uint8Array.from(payload).reverse()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						codec: Codec.LZOP,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('cba') }],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		codecMap: new Map([
			[Codec.LZOP, { codec: Codec.LZOP, compress: reverse, decompress: reverse }],
		]),
	})
	let [message] = await collect(reader, 1, tc.signal)
	expect(text(message!.payload)).toBe('abc')
})

test('fails the reader with a contextual error on a corrupt payload', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 7n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						codec: Codec.GZIP,
						messages: [{ offset: 42n, seqNo: 1n, data: bytes('definitely-not-gzip') }],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let thrown: unknown
	try {
		await collect(reader, 1, tc.signal)
	} catch (error) {
		thrown = error
	}
	expect(String(thrown)).toContain('offset 42 of partition 7')
	expect(String(thrown)).toContain('/t')
	expect((thrown as Error).cause).toBeDefined()
	let commit = reader.commit([])
	await expect(commit).rejects.toThrow('offset 42 of partition 7')
	let closing = reader.close()
	await expect(closing).rejects.toThrow('offset 42 of partition 7')
})

test('keeps tx offset ranges isolated per partition under equal and lower redelivery', async (tc) => {
	let offsets: UpdateOffsetsInTransactionRequest[] = []
	let higher = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let started = 0
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 5n,
					})
					yield startPartitionSession({
						partitionSessionId: 2n,
						partitionId: 20n,
						committedOffset: 100n,
					})
				}
				if (request.case === 'startPartitionSessionResponse' && ++started === 2) {
					let repeated = readResponse({
						partitionSessionId: 1n,
						messages: [
							{ offset: 5n, seqNo: 1n, data: bytes('a') },
							{ offset: 6n, seqNo: 2n, data: bytes('b') },
						],
					})
					yield repeated
					yield readResponse({
						partitionSessionId: 2n,
						messages: [{ offset: 100n, seqNo: 1n, data: bytes('x') }],
					})
					yield repeated
					await abortable(context.signal, higher.promise)
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 7n, seqNo: 3n, data: bytes('c') }],
					})
				}
			}
		},
		updateOffsetsInTransaction(request) {
			offsets.push(request)
			return create(UpdateOffsetsInTransactionResponseSchema, {
				operation: { ready: true, status: StatusIds_StatusCode.SUCCESS },
			})
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let transaction = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 5, tc.signal)
	higher.resolve()
	await collect(reader, 1, tc.signal)
	await transaction.commit(tc.signal)
	expect(offsets).toHaveLength(1)
	let byPartition = new Map(
		offsets[0]!.topics[0]!.partitions.map((partition) => [
			partition.partitionId,
			partition.partitionOffsets,
		])
	)
	expect(byPartition.get(10n)).toEqual([expect.objectContaining({ start: 5n, end: 8n })])
	expect(byPartition.get(20n)).toEqual([expect.objectContaining({ start: 100n, end: 101n })])
})

test('keeps the tx offset range monotonic when the server redelivers lower offsets after reconnect', async (tc) => {
	let offsets: UpdateOffsetsInTransactionRequest[] = []
	let reconnect = Promise.withResolvers<void>()
	let streams = 0
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let id = BigInt(++streams)
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse(`session-${id}`)
					yield startPartitionSession({
						partitionSessionId: id,
						partitionId: 10n,
						committedOffset: 5n,
					})
				}
				if (request.case === 'startPartitionSessionResponse') {
					let messages = [{ offset: 5n, seqNo: 1n, data: bytes('a') }]
					if (id === 1n) messages.push({ offset: 6n, seqNo: 2n, data: bytes('b') })
					yield readResponse({ partitionSessionId: id, messages })
					if (id === 1n) {
						await abortable(context.signal, reconnect.promise)
						return
					}
				}
			}
		},
		updateOffsetsInTransaction(request) {
			offsets.push(request)
			return create(UpdateOffsetsInTransactionResponseSchema, {
				operation: { ready: true, status: StatusIds_StatusCode.SUCCESS },
			})
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let transaction = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 2, tc.signal)
	reconnect.resolve()
	await collect(reader, 1, tc.signal)
	await transaction.commit(tc.signal)
	expect(offsets).toHaveLength(1)
	expect(offsets[0]!.topics[0]!.partitions[0]!.partitionOffsets).toEqual([
		expect.objectContaining({ start: 5n, end: 7n }),
	])
})

test('re-sends a reconciled commit only after the start response on the new stream', async (tc) => {
	let streams = 0
	let received: StreamReadMessage_FromClient[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let id = BigInt(++streams)
			for await (let message of requests) {
				let request = message.clientMessage
				if (id === 2n) received.push(message)
				if (request.case === 'initRequest') {
					yield initResponse(`session-${id}`)
					yield startPartitionSession({ partitionSessionId: id, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse' && id === 1n)
					yield readResponse({
						partitionSessionId: id,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
						],
					})
				if (request.case === 'commitOffsetRequest') {
					if (id === 1n) return
					yield commitOffsetResponse([{ partitionSessionId: id, committedOffset: 2n }])
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 2, tc.signal)
	let committing = reader.commit(messages)
	await expect(committing).resolves.toBeUndefined()
	let order = received.map((message) => message.clientMessage.case)
	let start = order.indexOf('startPartitionSessionResponse')
	let commit = order.indexOf('commitOffsetRequest')
	expect(start).toBeGreaterThanOrEqual(0)
	expect(commit).toBeGreaterThanOrEqual(0)
	expect(start).toBeLessThan(commit)
	let request = received[commit]!.clientMessage
	if (request.case !== 'commitOffsetRequest') throw new Error('Missing reconciled commit')
	expect(request.value.commitOffsets[0]!.partitionSessionId).toBe(2n)
})

test('withholds the start response until the async hook resolves', async () => {
	let gate = Promise.withResolvers<void>()
	let entered = Promise.withResolvers<void>()
	let acknowledgments: StreamReadMessage_StartPartitionSessionResponse[] = []
	let acknowledged = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 0n,
						end: 10n,
					})
				}
				if (request.case === 'startPartitionSessionResponse') {
					acknowledgments.push(request.value)
					acknowledged.resolve()
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: async () => {
			entered.resolve()
			await gate.promise
			return { readOffset: 5n }
		},
	})
	await entered.promise
	await new Promise((resolve) => setTimeout(resolve, 20))
	expect(acknowledgments).toEqual([])
	gate.resolve()
	await acknowledged.promise
	let response = acknowledgments[0]!
	expect(response.partitionSessionId).toBe(1n)
	expect(response.readOffset).toBe(5n)
	await reader.close()
})

test('keeps other partitions and destroy() working while a start hook hangs', async (tc) => {
	let hung = 0
	let started: bigint[] = []
	let aborted = Promise.withResolvers<void>()
	let cancelled = false
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			context.signal.addEventListener(
				'abort',
				() => {
					cancelled = true
					aborted.resolve()
				},
				{ once: true }
			)
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 20n })
				}
				if (request.case === 'startPartitionSessionResponse') {
					started.push(request.value.partitionSessionId)
					yield readResponse({
						partitionSessionId: 2n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
					})
				}
				if (request.case === 'commitOffsetRequest')
					yield commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 1n }])
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: (session) => {
			if (session.partitionId === 10n) {
				hung++
				return new Promise(() => {})
			}
			return Promise.resolve(undefined)
		},
	})
	let messages = await collect(reader, 1, tc.signal)
	expect(hung).toBe(1)
	expect(started).toEqual([2n])
	await reader.commit(messages)
	reader.destroy(new Error('bye'))
	await aborted.promise
	expect(cancelled).toBe(true)
})

test('sends the start response without offsets when the hook throws and keeps reading', async (tc) => {
	let acknowledgments: StreamReadMessage_StartPartitionSessionResponse[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 5n,
					})
				}
				if (request.case === 'startPartitionSessionResponse') {
					acknowledgments.push(request.value)
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 5n, seqNo: 1n, data: bytes('ok') }],
					})
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: () => Promise.reject(new Error('offset store down')),
	})
	let messages = await collect(reader, 1, tc.signal)
	let ack = acknowledgments[0]!
	expect(ack.partitionSessionId).toBe(1n)
	expect(ack.readOffset).toBeUndefined()
	expect(ack.commitOffset).toBeUndefined()
	expect(messages).toHaveLength(1)
})

test('releases a response only after its final limit slice is yielded', async (tc) => {
	let credits: bigint[] = []
	let replenished = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'readRequest') {
					credits.push(request.value.bytesSize)
					if (credits.length === 2) replenished.resolve()
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 500n,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
							{ offset: 2n, seqNo: 3n, data: bytes('c') },
							{ offset: 3n, seqNo: 4n, data: bytes('d') },
						],
					})
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes: 1000n })
	for await (let batch of reader.read({ limit: 2, signal: tc.signal })) {
		expect(batch).toHaveLength(2)
		break
	}
	expect(reader.bufferedBytes).toBe(500n)
	expect(credits).toEqual([1000n])
	for await (let batch of reader.read({ limit: 2, signal: tc.signal })) {
		expect(batch).toHaveLength(2)
		break
	}
	await replenished.promise
	expect(credits).toEqual([1000n, 500n])
})

test('keeps blocking past a fully filtered chunk until a delivered chunk arrives', async (tc) => {
	let deliver = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse') {
					if (request.value.partitionSessionId === 1n) {
						yield readResponse({
							partitionSessionId: 1n,
							bytesSize: 100n,
							messages: [{ offset: 0n, seqNo: 1n, data: bytes('stale') }],
						})
						await abortable(context.signal, deliver.promise)
						yield stopPartitionSession({ partitionSessionId: 1n, graceful: false })
						yield startPartitionSession({ partitionSessionId: 2n, partitionId: 20n })
					} else
						yield readResponse({
							partitionSessionId: 2n,
							bytesSize: 100n,
							messages: [{ offset: 0n, seqNo: 1n, data: bytes('live') }],
						})
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
		onPartitionSessionStop: async () => {
			stopped.resolve()
		},
	})
	await expect.poll(() => reader.bufferedBytes).toBe(100n)
	deliver.resolve()
	await stopped.promise
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch).toHaveLength(1)
		expect(batch[0]!.partitionSession.deref()!.partitionId).toBe(20n)
		expect(text(batch[0]!.payload)).toBe('live')
		break
	}
})

test('delivers buffered messages of an ended partition and commits them', async (tc) => {
	let ended = Promise.withResolvers<void>()
	let commitPartitionCounts: number[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes('a') },
							{ offset: 1n, seqNo: 2n, data: bytes('b') },
						],
					})
					yield create(StreamReadMessage_FromServerSchema, {
						status: StatusIds_StatusCode.SUCCESS,
						serverMessage: {
							case: 'endPartitionSession',
							value: { partitionSessionId: 1n },
						},
					})
				}
				if (request.case === 'commitOffsetRequest') {
					commitPartitionCounts.push(request.value.commitOffsets.length)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 2n }])
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: async () => {
			ended.resolve()
		},
	})
	await ended.promise
	expect(reader.bufferedBytes).toBe(2n)
	let delivered = await collect(reader, 2, tc.signal)
	let offsets = delivered.map((message) => message.offset)
	expect(offsets).toEqual([0n, 1n])
	let commit = reader.commit(delivered)
	await expect(commit).resolves.toBeUndefined()
	expect(commitPartitionCounts).toEqual([1])
})

test('delivers buffered messages while a graceful stop waits on pending commits', async (tc) => {
	let acknowledge = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let stops = 0
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
					})
				if (request.case === 'commitOffsetRequest') {
					yield stopPartitionSession({ partitionSessionId: 1n, graceful: true })
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 1n, seqNo: 2n, data: bytes('b') }],
					})
					await abortable(context.signal, acknowledge.promise)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }])
				}
				if (request.case === 'stopPartitionSessionResponse') {
					stops++
					stopped.resolve()
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let first = await collect(reader, 1, tc.signal)
	let commit = reader.commit(first)
	let second = await collect(reader, 1, tc.signal)
	let offsets = second.map((message) => message.offset)
	expect(offsets).toEqual([1n])
	acknowledge.resolve()
	await expect(commit).resolves.toBeUndefined()
	await stopped.promise
	expect(stops).toBe(1)
})

test('sends a token refresh on the update interval', async () => {
	let refreshed = Promise.withResolvers<string>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') yield initResponse()
				if (request.case === 'updateTokenRequest') refreshed.resolve(request.value.token)
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: { getToken: () => Promise.resolve('current-token') },
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		updateTokenIntervalMs: 20,
	})
	expect(await refreshed.promise).toBe('current-token')
	await reader.close()
})

test('keeps refreshing the token on the new stream after a reconnect', async () => {
	let streams = 0
	let tokens: string[] = []
	let refreshed = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let id = ++streams
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') yield initResponse(`session-${id}`)
				if (request.case === 'updateTokenRequest') {
					tokens.push(request.value.token)
					if (id === 1) return
					refreshed.resolve()
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: { getToken: () => Promise.resolve('current-token') },
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		updateTokenIntervalMs: 20,
	})
	await refreshed.promise
	expect(streams).toBe(2)
	expect(tokens).toEqual(['current-token', 'current-token'])
	await reader.close()
})

test('coalesces credential acquisition and refreshes without an ACK for the previous token', async () => {
	let pending = Promise.withResolvers<string>()
	let ready = Promise.withResolvers<void>()
	let refreshed = Promise.withResolvers<void>()
	let tokens: string[] = []
	let refresh = vi.fn(() => pending.promise)
	let refreshing = false
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					refreshing = true
					yield initResponse()
				}
				if (request.case === 'readRequest') ready.resolve()
				if (request.case === 'updateTokenRequest') {
					tokens.push(request.value.token)
					if (tokens.length === 2) refreshed.resolve()
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: {
			getToken: () => (refreshing ? refresh() : Promise.resolve('initial-token')),
		},
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		updateTokenIntervalMs: 5,
	})
	await ready.promise
	await new Promise((resolve) => setTimeout(resolve, 60))
	expect(refresh).toHaveBeenCalledTimes(1)
	refresh.mockResolvedValue('renewed-token')
	pending.resolve('unchanged-token')
	await refreshed.promise
	expect(tokens.slice(0, 2)).toEqual(['unchanged-token', 'renewed-token'])
	await reader.close()
})

test('closes gracefully and aborts the underlying stream', async () => {
	let ready = Promise.withResolvers<void>()
	let aborted = Promise.withResolvers<void>()
	let cancelled = false
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			context.signal.addEventListener(
				'abort',
				() => {
					cancelled = true
					aborted.resolve()
				},
				{ once: true }
			)
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse') ready.resolve()
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	await ready.promise
	await reader.close()
	await aborted.promise
	expect(cancelled).toBe(true)
})

test('waits for pending commit acknowledgements during async disposal', async (tc) => {
	let requested = Promise.withResolvers<void>()
	let acknowledge = Promise.withResolvers<void>()
	let aborted = Promise.withResolvers<void>()
	let cancelled = false
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			context.signal.addEventListener(
				'abort',
				() => {
					cancelled = true
					aborted.resolve()
				},
				{ once: true }
			)
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse')
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
					})
				if (request.case === 'commitOffsetRequest') {
					requested.resolve()
					await abortable(context.signal, acknowledge.promise)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }])
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 1, tc.signal)
	let committed = reader.commit(messages)
	let disposed = false
	let disposing = reader[Symbol.asyncDispose]().then(() => {
		disposed = true
		return undefined
	})
	await requested.promise
	expect(disposed).toBe(false)
	expect(cancelled).toBe(false)
	acknowledge.resolve()
	await Promise.all([committed, disposing, aborted.promise])
	expect(disposed).toBe(true)
	expect(cancelled).toBe(true)
})

test('keeps the configured source filters when caller-owned options change', async () => {
	let initializations: StreamReadMessage_InitRequest[] = []
	let reopened = Promise.withResolvers<void>()
	let streams = 0
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let id = ++streams
			for await (let { clientMessage: request } of requests) {
				if (request.case === 'initRequest') {
					initializations.push(request.value)
					yield initResponse(`session-${id}`)
					if (id === 2) reopened.resolve()
				}
				if (request.case === 'readRequest' && id === 1) return
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let source = {
		path: '/t',
		partitionIds: [1n],
		maxLag: create(DurationSchema, { seconds: 10n }),
		readFrom: create(TimestampSchema, { seconds: 20n }),
	}
	using reader = createTopicReader(driver, { topic: source, consumer: 'c' })
	source.partitionIds.push(2n)
	source.maxLag.seconds = 100n
	source.readFrom.seconds = 200n
	await reopened.promise
	let first = initializations[0]!
	let replacement = initializations[1]!
	expect(first.topicsReadSettings).toMatchObject([
		{ path: '/t', partitionIds: [1n], maxLag: { seconds: 10n }, readFrom: { seconds: 20n } },
	])
	expect(replacement.topicsReadSettings).toEqual(first.topicsReadSettings)
	await reader.close()
})
