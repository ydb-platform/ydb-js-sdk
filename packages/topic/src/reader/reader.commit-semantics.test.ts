import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_CommitOffsetRequest,
	type StreamReadMessage_FromServer,
	StreamReadMessage_FromServerSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { RpcError, Server, Status } from '@ydbjs/grpc'
import { AsyncQueue } from '@ydbjs/fsm/queue'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	partitionStatusResponse,
	readResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'

let bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

async function collect(
	reader: ReturnType<typeof createTopicReader>,
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

function endPartitionSession(partitionSessionId: bigint) {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		serverMessage: { case: 'endPartitionSession', value: { partitionSessionId } },
	})
}

test('batches per-message commits from one turn behind one promise and one wire request', async (tc) => {
	let count = 1000
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 0n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: Array.from({ length: count }, (_, offset) => BigInt(offset)).map(
							(offset, index) => ({
								offset,
								seqNo: BigInt(index + 1),
								data: bytes(String(offset)),
							})
						),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1000n }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, count, tc.signal)
	let promises: Promise<void>[] = []
	for (let message of messages) promises.push(reader.commit(message))
	expect(new Set(promises).size).toBe(1)
	let results = Promise.all(promises)
	await expect(results).resolves.toHaveLength(count)
	expect(commits).toHaveLength(1)
	let request = commits[0]!
	expect(request.commitOffsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.offsets).toMatchObject([{ start: 0n, end: BigInt(count) }])
})

test('merges message and array commit inputs into the same microtask batch', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 0n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [0n, 1n, 2n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 3n }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 3, tc.signal)
	let first = reader.commit(messages[0]!)
	let rest = reader.commit(messages.slice(1))
	expect(first).toBe(rest)
	await expect(first).resolves.toBeUndefined()
	expect(commits[0]!.commitOffsets[0]!.offsets).toMatchObject([{ start: 0n, end: 3n }])
})

test('keeps separate microtask batches pending behind the same server watermark', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 5n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [5n, 6n, 7n, 8n, 9n, 10n, 11n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					if (commits.length === 2)
						yield commitOffsetResponse([
							{ partitionSessionId: 1n, committedOffset: 12n },
						])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 7, tc.signal)
	let first = reader.commit(messages.slice(0, 5))
	await expect.poll(() => commits.length).toBe(1)
	expect(commits[0]!.commitOffsets[0]!.offsets).toMatchObject([{ start: 5n, end: 10n }])
	let second = reader.commit(messages.slice(2))
	expect(second).not.toBe(first)
	let completed = Promise.all([first, second])
	await expect(completed).resolves.toEqual([undefined, undefined])
	expect(commits).toHaveLength(2)
	expect(commits[1]!.commitOffsets[0]!.offsets).toMatchObject([{ start: 10n, end: 12n }])
})

test('keeps a duplicate from a later microtask pending without sending it twice', async (tc) => {
	let commitReceived = Promise.withResolvers<void>()
	let probeReceived = Promise.withResolvers<void>()
	let requestsFinished = Promise.withResolvers<void>()
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using responses = new AsyncQueue<StreamReadMessage_FromServer>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		streamRead(requests) {
			let receiving = (async () => {
				try {
					for await (let { clientMessage } of requests) {
						if (clientMessage.case === 'initRequest') {
							responses.push(initResponse())
							responses.push(
								startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
							)
						}
						if (clientMessage.case === 'startPartitionSessionResponse') {
							if (clientMessage.value.partitionSessionId === 1n) {
								responses.push(
									readResponse({
										partitionSessionId: 1n,
										messages: [
											{ offset: 0n, seqNo: 1n, data: bytes('message') },
										],
									})
								)
							} else probeReceived.resolve()
						}
						if (clientMessage.case === 'commitOffsetRequest') {
							commits.push(clientMessage.value)
							commitReceived.resolve()
						}
					}
				} finally {
					requestsFinished.resolve()
				}
			})()
			void receiving.catch((error: unknown) => responses.fail(error))
			return responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let [message] = await collect(reader, 1, tc.signal)
	let first = reader.commit(message!)
	await commitReceived.promise
	let duplicate = reader.commit(message!)
	let duplicateSettled = false
	void duplicate.then(
		() => (duplicateSettled = true),
		() => false
	)
	await settle()
	// Reading a later frame proves the server has consumed any preceding duplicate commit.
	responses.push(startPartitionSession({ partitionSessionId: 2n, partitionId: 11n }))
	await probeReceived.promise
	expect(duplicateSettled).toBe(false)
	expect(commits).toHaveLength(1)
	responses.push(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	let completed = Promise.all([first, duplicate])
	await expect(completed).resolves.toEqual([undefined, undefined])
	await reader.close()
	await requestsFinished.promise
	expect(commits).toHaveLength(1)
})

test('commits only the acked message when earlier delivered messages are unacked', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 0n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [0n, 1n, 2n, 3n, 4n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 5n }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 5, tc.signal)
	let commit = reader.commit(messages[4]!)
	await expect(commit).resolves.toBeUndefined()
	let request = commits[0]!
	expect(request.commitOffsets[0]!.offsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.offsets[0]!.start).toBe(4n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(5n)
})

test('commits live partitions when the same batch contains a stopped partition', async (tc) => {
	let revoke = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let started = 0
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 20n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					let partitionSessionId = clientMessage.value.partitionSessionId
					yield readResponse({
						partitionSessionId,
						messages: [
							{ offset: 0n, seqNo: 1n, data: bytes(String(partitionSessionId)) },
						],
					})
					if (++started === 2) {
						await abortable(context.signal, revoke.promise)
						yield stopPartitionSession({
							partitionSessionId: 1n,
							graceful: false,
							committedOffset: 0n,
						})
					}
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 1n }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
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
	let messages = await collect(reader, 2, tc.signal)
	revoke.resolve()
	await stopped.promise
	let commit = reader.commit(messages)
	await expect(commit).rejects.toThrow(/stopped or expired partition session/)
	expect(commits).toHaveLength(1)
	expect(commits[0]!.commitOffsets).toEqual([
		expect.objectContaining({
			partitionSessionId: 2n,
			offsets: [expect.objectContaining({ start: 0n, end: 1n })],
		}),
	])
})

test('gap-fills the first commit range from the server committed offset across a retention hole', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 2n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [5n, 6n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 6n }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 2, tc.signal)
	let commit = reader.commit(messages[0]!)
	await expect(commit).resolves.toBeUndefined()
	let request = commits[0]!
	expect(request.commitOffsets[0]!.offsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.offsets[0]!.start).toBe(2n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(6n)
})

test('sends the gap offsets to the wire so a sparse commit() can resolve', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 5n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [5n, 6n, 7n, 8n, 9n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([
						{
							partitionSessionId: 1n,
							committedOffset: commits.length === 1 ? 6n : 10n,
						},
					])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 5, tc.signal)
	let sparse = reader.commit([messages[0]!, messages[4]!])
	await expect.poll(() => commits.length).toBe(1)
	let ranges = commits[0]!.commitOffsets[0]!.offsets.map((range) => [range.start, range.end])
	expect(ranges).toEqual([
		[5n, 6n],
		[9n, 10n],
	])
	let gap = reader.commit([messages[1]!, messages[2]!, messages[3]!])
	await expect(gap).resolves.toBeUndefined()
	await expect(sparse).resolves.toBeUndefined()
	expect(commits).toHaveLength(2)
})

test('rejects a commit of a message owned by a different reader', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	let starts = 0
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let consumer = ''
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					consumer = clientMessage.value.consumer
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: consumer === 'consumer-a' ? 0n : 0n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					starts++
					if (consumer === 'consumer-b')
						yield readResponse({
							partitionSessionId: 1n,
							messages: [{ offset: 0n, seqNo: 1n, data: bytes('b') }],
						})
				}
				if (clientMessage.case === 'commitOffsetRequest') commits.push(clientMessage.value)
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using readerA = createTopicReader(driver, { topic: '/t', consumer: 'consumer-a' })
	using readerB = createTopicReader(driver, { topic: '/t', consumer: 'consumer-b' })
	let [foreign] = await collect(readerB, 1, tc.signal)
	await expect.poll(() => starts).toBe(2)
	let commit = readerA.commit(foreign!)
	await expect(commit).rejects.toThrow(/partition session/)
	expect(commits).toHaveLength(0)
})

test('rejects a foreign-reader commit whose partition is not granted locally', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	let starts = 0
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let consumer = ''
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					consumer = clientMessage.value.consumer
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: consumer === 'consumer-a' ? 0n : 5n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					starts++
					if (consumer === 'consumer-b')
						yield readResponse({
							partitionSessionId: 1n,
							messages: [{ offset: 0n, seqNo: 1n, data: bytes('b') }],
						})
				}
				if (clientMessage.case === 'commitOffsetRequest') commits.push(clientMessage.value)
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using readerA = createTopicReader(driver, { topic: '/t', consumer: 'consumer-a' })
	using readerB = createTopicReader(driver, { topic: '/t', consumer: 'consumer-b' })
	let [foreign] = await collect(readerB, 1, tc.signal)
	await expect.poll(() => starts).toBe(2)
	let commit = readerA.commit(foreign!)
	await expect(commit).rejects.toThrow(/partition session/)
	expect(commits).toHaveLength(0)
})

test('reports a start-session commitOffset after server status confirms it', async () => {
	let acks: bigint[] = []
	let startOffset: bigint | undefined
	let confirm = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 5n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					startOffset = clientMessage.value.commitOffset
					await abortable(context.signal, confirm.promise)
					yield partitionStatusResponse(1n, 10n)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: async () => ({ commitOffset: 10n }),
		onCommittedOffset: (_, committedOffset) => {
			acks.push(committedOffset)
		},
	})
	await expect.poll(() => startOffset).toBe(10n)
	expect(acks).toEqual([])
	confirm.resolve()
	await expect.poll(() => acks).toEqual([10n])
	await reader.close()
})

test('keeps a reconnected commit pending until the start override is confirmed', async (tc) => {
	let opened = 0
	let starts = 0
	let statusRequests = 0
	let confirmed: bigint[] = []
	let secondCommits: StreamReadMessage_CommitOffsetRequest[] = []
	let restarted = Promise.withResolvers<void>()
	let unconfirmedStatus = Promise.withResolvers<void>()
	let confirmedStatus = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let attempt = ++opened
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					if (attempt === 1) {
						yield readResponse({
							partitionSessionId: 1n,
							messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
						})
					} else {
						restarted.resolve()
						await abortable(context.signal, unconfirmedStatus.promise)
						yield partitionStatusResponse(1n, 0n)
					}
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					if (attempt === 1) return
					secondCommits.push(clientMessage.value)
				}
				if (attempt > 1 && clientMessage.case === 'partitionSessionStatusRequest') {
					if (++statusRequests === 2) {
						await abortable(context.signal, confirmedStatus.promise)
						yield partitionStatusResponse(1n, 1n)
					}
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: async () =>
			++starts > 1 ? { readOffset: 1n, commitOffset: 1n } : undefined,
		onCommittedOffset: (_, offset) => {
			confirmed.push(offset)
		},
	})
	let [message] = await collect(reader, 1, tc.signal)
	let pending = reader.commit(message!)
	let resolved = false
	void pending.then(
		() => (resolved = true),
		() => false
	)
	await restarted.promise
	expect(resolved).toBe(false)
	expect(confirmed).toEqual([])
	expect(secondCommits).toHaveLength(0)
	unconfirmedStatus.resolve()
	await expect.poll(() => statusRequests, { timeout: 3000 }).toBe(2)
	expect(secondCommits).toHaveLength(0)
	expect(resolved).toBe(false)
	confirmedStatus.resolve()
	await expect(pending).resolves.toBeUndefined()
	expect(confirmed).toEqual([1n])
})

test('recovers an applied commit whose acknowledgment was lost before reconnect', async (tc) => {
	let streams = 0
	let committedOffset = 0n
	let requests: StreamReadMessage_CommitOffsetRequest[] = []
	let reopened = Promise.withResolvers<void>()
	let confirm = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input, context) {
			let sessionId = BigInt(++streams)
			for await (let { clientMessage: request } of input) {
				if (request.case === 'initRequest') {
					yield initResponse(`session-${sessionId}`)
					if (sessionId === 2n) {
						reopened.resolve()
						await abortable(context.signal, confirm.promise)
					}
					yield startPartitionSession({
						partitionSessionId: sessionId,
						partitionId: 10n,
						committedOffset,
					})
				}
				if (request.case === 'startPartitionSessionResponse') {
					let offsets = sessionId === 1n ? [0n, 1n, 2n] : [3n]
					yield readResponse({
						partitionSessionId: sessionId,
						messages: offsets.map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
				}
				if (request.case === 'commitOffsetRequest') {
					requests.push(request.value)
					committedOffset = request.value.commitOffsets[0]!.offsets[0]!.end
					if (sessionId === 1n) {
						throw new RpcError(
							Status.UNAVAILABLE,
							'Connection lost before commit acknowledgment'
						)
					}
					yield commitOffsetResponse([{ partitionSessionId: sessionId, committedOffset }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = await collect(reader, 3, tc.signal)
	let completed = false
	let pending = reader.commit(messages).then(() => {
		completed = true
		return undefined
	})

	await reopened.promise
	expect(committedOffset).toBe(3n)
	expect(completed).toBe(false)

	confirm.resolve()
	await pending
	let following = await collect(reader, 1, tc.signal)
	expect(following.map((message) => message.offset)).toEqual([3n])

	await reader.commit(following)
	let commits = requests.flatMap((request) => request.commitOffsets)
	let ranges = commits.map((commit) => ({
		partitionSessionId: commit.partitionSessionId,
		offsets: commit.offsets.map(({ start, end }) => ({ start, end })),
	}))
	expect(ranges).toEqual([
		{ partitionSessionId: 1n, offsets: [{ start: 0n, end: 3n }] },
		{ partitionSessionId: 2n, offsets: [{ start: 3n, end: 4n }] },
	])
	expect(committedOffset).toBe(4n)
})

test('invokes onCommittedOffset for a commit acked after end_partition', async (tc) => {
	let acks: Array<{ partitionId: bigint; committedOffset: bigint }> = []
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 0n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [0n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
					yield endPartitionSession(1n)
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onCommittedOffset: (session, committedOffset) => {
			acks.push({ partitionId: session.partitionId, committedOffset })
		},
	})
	let [message] = await collect(reader, 1, tc.signal)
	await expect.poll(() => message!.partitionSession.deref()?.isEnded).toBe(true)
	let commit = reader.commit(message!)
	await expect(commit).resolves.toBeUndefined()
	expect(commits[0]!.commitOffsets[0]!.partitionSessionId).toBe(1n)
	expect(acks).toEqual([{ partitionId: 10n, committedOffset: 1n }])
})

test('invokes onCommittedOffset when a partition stop carries the committed watermark', async (tc) => {
	let acks: Array<{ partitionId: bigint; committedOffset: bigint }> = []
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 0n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [0n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield stopPartitionSession({
						partitionSessionId: 1n,
						graceful: false,
						committedOffset: 1n,
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onCommittedOffset: (session, committedOffset) => {
			acks.push({ partitionId: session.partitionId, committedOffset })
		},
	})
	let [message] = await collect(reader, 1, tc.signal)
	let commit = reader.commit(message!)
	await expect(commit).resolves.toBeUndefined()
	expect(acks).toEqual([{ partitionId: 10n, committedOffset: 1n }])
})

test('handles a rejected async commit observer without delaying commit', async (tc) => {
	let observer = Promise.withResolvers<void>()
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 0n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [0n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }])
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onCommittedOffset: async () => {
			await observer.promise
			throw new Error('Asynchronous commit observer failed')
		},
	})
	let messages = await collect(reader, 1, tc.signal)
	let committed = reader.commit(messages)
	await expect(committed).resolves.toBeUndefined()
	observer.resolve()
	await new Promise<void>((resolve) => setImmediate(resolve))
	await expect(reader.close()).resolves.toBeUndefined()
})
