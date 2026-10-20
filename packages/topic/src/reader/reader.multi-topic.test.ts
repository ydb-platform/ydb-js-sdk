import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_CommitOffsetRequest,
	TopicServiceDefinition,
	type UpdateOffsetsInTransactionRequest,
	UpdateOffsetsInTransactionResponseSchema,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { TopicReader, createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	makeFakeTx,
	readResponse,
	startPartitionSession,
} from './reader.fixtures.ts'

let bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
let text = (payload: Uint8Array): string => new TextDecoder().decode(payload)

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

test('delivers messages from both topics when their partition ids collide', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 0n,
						path: '/a',
					})
					yield startPartitionSession({
						partitionSessionId: 2n,
						partitionId: 0n,
						path: '/b',
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					let partitionSessionId = clientMessage.value.partitionSessionId
					yield readResponse({
						partitionSessionId,
						messages: [
							{
								offset: 0n,
								seqNo: 1n,
								data: bytes(partitionSessionId === 1n ? 'from-a' : 'from-b'),
							},
						],
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
		topic: [{ path: '/a' }, { path: '/b' }],
		consumer: 'c',
	})
	let messages = await collect(reader, 2, tc.signal)
	let payloads = messages.map((message) => text(message.payload)).sort()
	let paths = messages.map((message) => message.partitionSession.deref()?.topicPath).sort()
	expect(payloads).toEqual(['from-a', 'from-b'])
	expect(paths).toEqual(['/a', '/b'])
})

test('commits a first-topic message under its own partition session', async (tc) => {
	let commits: StreamReadMessage_CommitOffsetRequest[] = []
	let secondStarted = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 0n,
						path: '/a',
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					if (clientMessage.value.partitionSessionId === 1n) {
						yield readResponse({
							partitionSessionId: 1n,
							messages: [{ offset: 0n, seqNo: 1n, data: bytes('from-a') }],
						})
						yield startPartitionSession({
							partitionSessionId: 2n,
							partitionId: 0n,
							path: '/b',
						})
					} else {
						secondStarted.resolve()
					}
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
		topic: [{ path: '/a' }, { path: '/b' }],
		consumer: 'c',
	})
	let [message] = await collect(reader, 1, tc.signal)
	expect(message!.partitionSession.deref()?.topicPath).toBe('/a')
	await secondStarted.promise
	await reader.commit(message!)
	expect(commits).toHaveLength(1)
	expect(commits[0]!.commitOffsets[0]!.partitionSessionId).toBe(1n)
	expect(commits[0]!.commitOffsets[0]!.offsets[0]!.end).toBe(1n)
})

test('attributes tx offset ranges to each topic when partition ids collide', async (tc) => {
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 0n,
						path: '/a',
						committedOffset: 5n,
					})
					yield startPartitionSession({
						partitionSessionId: 2n,
						partitionId: 0n,
						path: '/b',
						committedOffset: 100n,
					})
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					let partitionSessionId = clientMessage.value.partitionSessionId
					let offsets = partitionSessionId === 1n ? [5n, 6n] : [100n]
					let messages = offsets.map((offset, index) => ({
						offset,
						seqNo: BigInt(index + 1),
						data: bytes(String(offset)),
					}))
					yield readResponse({ partitionSessionId, messages })
				}
			}
		},
		async updateOffsetsInTransaction(request) {
			txOffsetRequests.push(request)
			return create(UpdateOffsetsInTransactionResponseSchema, {
				operation: { ready: true, status: StatusIds_StatusCode.SUCCESS },
			})
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let transaction = makeFakeTx()
	using reader = new TopicReader(
		driver,
		{ topic: [{ path: '/a' }, { path: '/b' }], consumer: 'c' },
		{ tx: transaction.tx }
	)
	await collect(reader, 3, tc.signal)
	await transaction.commit(tc.signal)
	expect(txOffsetRequests).toHaveLength(1)
	let topics = txOffsetRequests[0]!.topics
	expect(topics).toHaveLength(2)
	let byPath = new Map(topics.map((topic) => [topic.path, topic.partitions]))
	expect(byPath.get('/a')).toEqual([
		expect.objectContaining({
			partitionId: 0n,
			partitionOffsets: [expect.objectContaining({ start: 5n, end: 7n })],
		}),
	])
	expect(byPath.get('/b')).toEqual([
		expect.objectContaining({
			partitionId: 0n,
			partitionOffsets: [expect.objectContaining({ start: 100n, end: 101n })],
		}),
	])
})
