import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	TopicServiceDefinition,
	type UpdateOffsetsInTransactionRequest,
	UpdateOffsetsInTransactionResponseSchema,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { TopicReader } from './index.ts'
import { initResponse, makeFakeTx, readResponse, startPartitionSession } from './reader.fixtures.ts'

let bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

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

test('binds only offsets delivered through read() to the transaction commit', async (tc) => {
	let delivered = Promise.withResolvers<void>()
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
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
						messages: [0n, 1n].map((offset, index) => ({
							offset,
							seqNo: BigInt(index + 1),
							data: bytes(String(offset)),
						})),
					})
					await abortable(context.signal, delivered.promise)
					yield readResponse({
						partitionSessionId: 1n,
						messages: [2n, 3n, 4n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
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
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 2, tc.signal)
	delivered.resolve()
	await expect.poll(() => reader.bufferedBytes).toBeGreaterThan(0n)
	await transaction.commit(tc.signal)
	expect(txOffsetRequests).toHaveLength(1)
	let offsets = txOffsetRequests[0]!.topics[0]!.partitions[0]!.partitionOffsets
	expect(offsets).toEqual([expect.objectContaining({ start: 0n, end: 2n })])
})

test('anchors the tx commit range at the server committed offset across a head gap', async (tc) => {
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({
						partitionSessionId: 1n,
						partitionId: 10n,
						committedOffset: 3n,
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
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 2, tc.signal)
	await transaction.commit(tc.signal)
	expect(txOffsetRequests).toHaveLength(1)
	let offsets = txOffsetRequests[0]!.topics[0]!.partitions[0]!.partitionOffsets
	expect(offsets).toEqual([expect.objectContaining({ start: 3n, end: 7n })])
})

test('routes UpdateOffsetsInTransaction to the transaction session node', async (tc) => {
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
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
	let createClient = vi.spyOn(driver, 'createClient')
	let transaction = makeFakeTx()
	Object.assign(transaction.tx, { nodeId: 42n })
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 1, tc.signal)
	createClient.mockClear()
	await transaction.commit(tc.signal)
	expect(txOffsetRequests).toHaveLength(1)
	expect(createClient.mock.calls.length).toBeGreaterThanOrEqual(1)
	expect(createClient.mock.calls[0]![0]).toBe(TopicServiceDefinition)
	expect(createClient.mock.calls[0]![1]).toBe(42n)
})

test('preserves tracked read offsets when the reader closes before the tx commit', async (tc) => {
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
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
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 1, tc.signal)
	await expect(reader.close()).resolves.toBeUndefined()
	let committing = transaction.commit(tc.signal)
	await expect(committing).resolves.toBeUndefined()
	expect(txOffsetRequests).toHaveLength(1)
	let offsets = txOffsetRequests[0]!.topics[0]!.partitions[0]!.partitionOffsets
	expect(offsets).toEqual([expect.objectContaining({ start: 0n, end: 1n })])
})

test('keeps the transaction consumer registered at reader creation', async (tc) => {
	let consumer: string | undefined
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					consumer = clientMessage.value.consumer
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
	let options = { topic: '/t', consumer: 'registered' }
	using reader = new TopicReader(driver, options, { tx: transaction.tx })
	options.consumer = 'replacement'
	await collect(reader, 1, tc.signal)
	expect(consumer).toBe('registered')
	await transaction.commit(tc.signal)
	expect(txOffsetRequests).toHaveLength(1)
	expect(txOffsetRequests[0]!.consumer).toBe('registered')
})

test('cancels a pending transaction-offset request with the commit hook signal', async (tc) => {
	let entered = Promise.withResolvers<void>()
	let cancelled = Promise.withResolvers<void>()
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
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
			}
		},
		async updateOffsetsInTransaction(request, context) {
			txOffsetRequests.push(request)
			entered.resolve()
			try {
				await abortable(context.signal, new Promise<never>(() => {}))
			} finally {
				if (context.signal.aborted) cancelled.resolve()
			}
			return create(UpdateOffsetsInTransactionResponseSchema)
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let transaction = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: transaction.tx })
	await collect(reader, 1, tc.signal)
	let controller = new AbortController()
	let reason = new Error('Transaction cancelled')
	let outcome = Promise.resolve(transaction.commit(controller.signal)).catch(
		(error: unknown) => error
	)
	await entered.promise
	controller.abort(reason)
	expect(await outcome).toBe(reason)
	await cancelled.promise
	expect(txOffsetRequests).toHaveLength(1)
})
