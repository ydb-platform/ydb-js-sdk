import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_CommitOffsetRequest,
	StreamReadMessage_FromServerSchema,
	type StreamReadMessage_InitRequest,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	readResponse,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'

let bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
let text = (payload: Uint8Array): string => new TextDecoder().decode(payload)

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

function endPartitionSession(childPartitionIds: bigint[]) {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		serverMessage: {
			case: 'endPartitionSession',
			value: { partitionSessionId: 1n, childPartitionIds },
		},
	})
}

test('declares autopartitioning support in the init request', async () => {
	let requests = new Map<string, StreamReadMessage_InitRequest>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input) {
			for await (let { clientMessage } of input) {
				if (clientMessage.case === 'initRequest') {
					requests.set(clientMessage.value.consumer, clientMessage.value)
					yield initResponse()
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using supporting = createTopicReader(driver, {
		topic: '/t',
		consumer: 'supporting',
		autoPartitioningSupport: true,
	})
	using plain = createTopicReader(driver, { topic: '/t', consumer: 'plain' })
	await expect.poll(() => requests.size).toBe(2)
	expect(requests.get('supporting')!.autoPartitioningSupport).toBe(true)
	expect(requests.get('plain')!.autoPartitioningSupport).toBe(false)
	await supporting.close()
	await plain.close()
})

test('keeps a split parent committable until its offsets are acked', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 0n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [0n, 1n, 2n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
					yield endPartitionSession([1n, 2n])
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
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		autoPartitioningSupport: true,
	})
	let messages = await collect(reader, 3, tc.signal)
	let session = messages[0]!.partitionSession.deref()
	await expect.poll(() => session?.isEnded).toBe(true)
	expect(session?.childPartitionIds).toEqual([1n, 2n])
	let commit = reader.commit(messages)
	await expect(commit).resolves.toBeUndefined()
	let request = commits[0]!
	expect(request.commitOffsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(1n)
	expect(request.commitOffsets[0]!.offsets[0]!.start).toBe(0n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(3n)
})

test('reads split children alongside the ended parent', async (tc) => {
	let parentDelivered = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 0n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					let partitionSessionId = clientMessage.value.partitionSessionId
					let payload =
						partitionSessionId === 1n ? 'parent' : `child-${partitionSessionId - 1n}`
					yield readResponse({
						partitionSessionId,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes(payload) }],
					})
					if (partitionSessionId === 1n) {
						await abortable(context.signal, parentDelivered.promise)
						yield endPartitionSession([1n, 2n])
						yield startPartitionSession({ partitionSessionId: 2n, partitionId: 1n })
						yield startPartitionSession({ partitionSessionId: 3n, partitionId: 2n })
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
		autoPartitioningSupport: true,
	})
	let parentMessages = await collect(reader, 1, tc.signal)
	let parentPayloads = parentMessages.map((message) => text(message.payload))
	expect(parentPayloads).toEqual(['parent'])
	expect(parentMessages[0]!.partitionSession.deref()?.partitionId).toBe(0n)
	parentDelivered.resolve()
	let childMessages = await collect(reader, 2, tc.signal)
	let byPartition = childMessages
		.map((message) => ({
			partitionId: message.partitionSession.deref()?.partitionId,
			topicPath: message.partitionSession.deref()?.topicPath,
			payload: text(message.payload),
		}))
		.sort((a, b) => Number(a.partitionId! - b.partitionId!))
	expect(byPartition).toEqual([
		{ partitionId: 1n, topicPath: '/t', payload: 'child-1' },
		{ partitionId: 2n, topicPath: '/t', payload: 'child-2' },
	])
})

test('delivers child data granted before the parent commit is acked', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	let childDelivered = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 0n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					let partitionSessionId = clientMessage.value.partitionSessionId
					yield readResponse({
						partitionSessionId,
						messages: [
							{
								offset: 0n,
								seqNo: 1n,
								data: bytes(partitionSessionId === 1n ? 'parent' : 'child'),
							},
						],
					})
					if (partitionSessionId === 1n) yield endPartitionSession([1n])
					else {
						await abortable(context.signal, childDelivered.promise)
						yield commitOffsetResponse([
							{ partitionSessionId: 1n, committedOffset: 1n },
						])
					}
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					commits.push(clientMessage.value)
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 1n })
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
		autoPartitioningSupport: true,
	})
	let [parentMessage] = await collect(reader, 1, tc.signal)
	await expect.poll(() => parentMessage!.partitionSession.deref()?.isEnded).toBe(true)
	let commit = reader.commit(parentMessage!)
	let childMessages = await collect(reader, 1, tc.signal)
	let payloads = childMessages.map((message) => text(message.payload))
	expect(commits[0]!.commitOffsets[0]!.partitionSessionId).toBe(1n)
	expect(payloads).toEqual(['child'])
	expect(childMessages[0]!.partitionSession.deref()?.partitionId).toBe(1n)
	childDelivered.resolve()
	await expect(commit).resolves.toBeUndefined()
})

test('delivers a granted child after an ended parent is forcibly stopped', async (tc) => {
	let grants: bigint[] = []
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	let parentStopped = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 0n })
				}
				if (clientMessage.case === 'readRequest') grants.push(clientMessage.value.bytesSize)
				if (clientMessage.case === 'startPartitionSessionResponse') {
					let partitionSessionId = clientMessage.value.partitionSessionId
					yield readResponse({
						partitionSessionId,
						bytesSize: partitionSessionId === 1n ? 11n : 17n,
						messages: [
							{
								offset: 0n,
								seqNo: 1n,
								data: bytes(partitionSessionId === 1n ? 'parent' : 'child'),
							},
						],
					})
					if (partitionSessionId === 1n) {
						yield endPartitionSession([1n])
						yield startPartitionSession({ partitionSessionId: 2n, partitionId: 1n })
					} else yield stopPartitionSession({ partitionSessionId: 1n, graceful: false })
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
		autoPartitioningSupport: true,
		maxBufferBytes: 100n,
		onPartitionSessionStop: async () => {
			parentStopped.resolve()
		},
	})
	await parentStopped.promise
	let messages = await collect(reader, 1, tc.signal)
	let payloads = messages.map((message) => text(message.payload))
	expect(payloads).toEqual(['child'])
	await reader.commit(messages)
	expect(commits[0]!.commitOffsets[0]!.partitionSessionId).toBe(2n)
	let grantedBytes = () => grants.reduce((sum, grant) => sum + grant, 0n)
	await expect.poll(grantedBytes).toBe(128n)
	expect(reader.bufferedBytes).toBe(0n)
})
