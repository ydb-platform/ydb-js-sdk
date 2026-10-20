import { abortable } from '@ydbjs/abortable'
import { Codec, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import { createTopicReader } from './index.ts'
import {
	initResponse,
	readResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'

let bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
let text = (payload: Uint8Array): string => new TextDecoder().decode(payload)

test('rejects a zero read limit', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 1n,
						messages: [0n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	await expect.poll(() => reader.bufferedBytes).toBe(1n)
	let read = () => reader.read({ limit: 0, signal: tc.signal })
	expect(read).toThrow(/limit/)
})

test('delivers a large batch of tiny messages without overflowing the argument stack', async (tc) => {
	let count = 150_000
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 4_000_000n,
						messages: Array.from({ length: count }, (_, index) => BigInt(index)).map(
							(offset) => ({
								offset,
								seqNo: offset + 1n,
								data: new Uint8Array([Number(offset % 256n)]),
							})
						),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch).toHaveLength(count)
		expect(batch[0]!.offset).toBe(0n)
		expect(batch.at(-1)!.offset).toBe(BigInt(count - 1))
		break
	}
})

test('rejects a negative read limit', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 1n,
						messages: [0n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	await expect.poll(() => reader.bufferedBytes).toBe(1n)
	let read = () => reader.read({ limit: -1, signal: tc.signal })
	expect(read).toThrow(/limit/)
})

test('redelivers messages dequeued by an aborted read()', async (tc) => {
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 300n,
						messages: [0n, 1n, 2n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 200n,
						messages: [3n, 4n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes: 1000n })
	await expect.poll(() => reader.bufferedBytes).toBe(500n)
	let controller = new AbortController()
	let thrown: unknown
	let consume = (async () => {
		try {
			for await (let batch of reader.read({
				batchWindowMs: 60_000,
				signal: controller.signal,
			}))
				void batch
		} catch (error) {
			thrown = error
		}
	})()
	await settle()
	controller.abort(new Error('consumer aborted'))
	await consume
	expect(String(thrown)).toContain('consumer aborted')
	expect(grants).toEqual([1000n])
	expect(reader.bufferedBytes).toBe(500n)
	let redelivered: bigint[] = []
	for await (let batch of reader.read({ batchWindowMs: 10, signal: tc.signal })) {
		for (let message of batch) redelivered.push(message.offset!)
		if (redelivered.length >= 5) break
	}
	expect(redelivered).toEqual([0n, 1n, 2n, 3n, 4n])
	await expect.poll(() => grants).toEqual([1000n, 500n])
	expect(reader.bufferedBytes).toBe(0n)
})

test('preserves the remaining slices when a read is aborted between yields', async (tc) => {
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 300n,
						messages: [0n, 1n, 2n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes: 1000n })
	let controller = new AbortController()
	let reason = new Error('stop reading')
	let iterator = reader.read({ limit: 1, signal: controller.signal })[Symbol.asyncIterator]()
	let first = await iterator.next()
	if (first.done) throw new Error('Expected a read batch')
	let firstOffsets = first.value.map((message) => message.offset)
	expect(firstOffsets).toEqual([0n])
	controller.abort(reason)
	let next = iterator.next()
	await expect(next).rejects.toBe(reason)
	expect(reader.bufferedBytes).toBe(300n)
	expect(grants).toEqual([1000n])
	let cancelled = reader.read({ limit: 1, signal: controller.signal })[Symbol.asyncIterator]()
	let cancelledNext = cancelled.next()
	await expect(cancelledNext).rejects.toBe(reason)
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		let offsets = batch.map((message) => message.offset)
		expect(offsets).toEqual([1n])
		break
	}
	expect(reader.bufferedBytes).toBe(300n)
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		let offsets = batch.map((message) => message.offset)
		expect(offsets).toEqual([2n])
		break
	}
	expect(reader.bufferedBytes).toBe(0n)
	await expect.poll(() => grants).toEqual([1000n, 300n])
})

test('drops revoked slices and releases their response credit once between yields', async (tc) => {
	let revoke = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let nextResponse = Promise.withResolvers<void>()
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let started = 0
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 11n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
					if (clientMessage.value.bytesSize === 300n) {
						await abortable(context.signal, nextResponse.promise)
						yield readResponse({
							partitionSessionId: 2n,
							bytesSize: 100n,
							messages: [0n].map((offset) => ({
								offset,
								seqNo: offset + 1n,
								data: bytes('live'),
							})),
						})
					}
				}
				if (clientMessage.case === 'startPartitionSessionResponse' && ++started === 2) {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 300n,
						messages: [0n, 1n, 2n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
					await abortable(context.signal, revoke.promise)
					yield stopPartitionSession({ partitionSessionId: 1n })
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
		maxBufferBytes: 1000n,
		onPartitionSessionStop: async () => {
			stopped.resolve()
		},
	})
	await expect.poll(() => reader.bufferedBytes).toBe(300n)
	let reading = reader.read({ limit: 1, batchWindowMs: 5, signal: tc.signal })
	let iterator = reading[Symbol.asyncIterator]()
	try {
		let first = await iterator.next()
		if (first.done) throw new Error('Expected a read batch')
		let offsets = first.value.map((message) => message.offset)
		expect(offsets).toEqual([0n])
		revoke.resolve()
		await stopped.promise
		let empty = await iterator.next()
		expect(empty.value).toEqual([])
		expect(reader.bufferedBytes).toBe(0n)
		await expect.poll(() => grants).toEqual([1000n, 300n])
		nextResponse.resolve()
		await expect.poll(() => reader.bufferedBytes).toBe(100n)
		let live = await iterator.next()
		if (live.done) throw new Error('Expected a read batch')
		let payloads = live.value.map((message) => text(message.payload))
		expect(payloads).toEqual(['live'])
	} finally {
		await iterator.return?.()
	}
	await expect.poll(() => grants).toEqual([1000n, 300n, 100n])
	expect(reader.bufferedBytes).toBe(0n)
})

test('retains shared response credit until its live partition finishes after a stop', async (tc) => {
	let revoke = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let response = readResponse({
		partitionSessionId: 1n,
		bytesSize: 400n,
		messages: [0n, 1n].map((offset) => ({
			offset,
			seqNo: offset + 1n,
			data: bytes('stopped'),
		})),
	})
	let second = readResponse({
		partitionSessionId: 2n,
		messages: [0n, 1n].map((offset) => ({ offset, seqNo: offset + 1n, data: bytes('live') })),
	})
	if (
		response.serverMessage.case !== 'readResponse' ||
		second.serverMessage.case !== 'readResponse'
	) {
		throw new Error('Expected read response fixtures')
	}
	response.serverMessage.value.partitionData.push(second.serverMessage.value.partitionData[0]!)
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let started = 0
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 11n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
				}
				if (clientMessage.case === 'startPartitionSessionResponse' && ++started === 2) {
					yield response
					await abortable(context.signal, revoke.promise)
					yield stopPartitionSession({ partitionSessionId: 1n })
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
		maxBufferBytes: 1000n,
		onPartitionSessionStop: async () => {
			stopped.resolve()
		},
	})
	let iterator = reader.read({ limit: 1, signal: tc.signal })[Symbol.asyncIterator]()
	try {
		let first = await iterator.next()
		if (first.done) throw new Error('Expected a read batch')
		let firstPayloads = first.value.map((message) => text(message.payload))
		expect(firstPayloads).toEqual(['stopped'])
		revoke.resolve()
		await stopped.promise
		let live = await iterator.next()
		if (live.done) throw new Error('Expected a read batch')
		let livePayloads = live.value.map((message) => text(message.payload))
		expect(livePayloads).toEqual(['live'])
		expect(reader.bufferedBytes).toBe(400n)
		expect(grants).toEqual([1000n])
	} finally {
		await iterator.return?.()
	}
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		let values = batch.map((message) => [text(message.payload), message.offset])
		expect(values).toEqual([['live', 1n]])
		break
	}
	expect(reader.bufferedBytes).toBe(0n)
	await expect.poll(() => grants).toEqual([1000n, 400n])
})

test('accepts an oversized response and replenishes the full server-reported bytes', async (tc) => {
	let sendFirst = Promise.withResolvers<void>()
	let sendSecond = Promise.withResolvers<void>()
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
					if (clientMessage.value.bytesSize === 5000n) {
						await abortable(context.signal, sendSecond.promise)
						yield readResponse({
							partitionSessionId: 1n,
							bytesSize: 600n,
							messages: [1n].map((offset) => ({
								offset,
								seqNo: offset + 1n,
								data: bytes('next'),
							})),
						})
					}
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					await abortable(context.signal, sendFirst.promise)
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 5000n,
						messages: [0n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes('oversized'),
						})),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes: 1024n })
	await expect.poll(() => grants).toEqual([1024n])
	sendFirst.resolve()
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		let payloads = batch.map((message) => text(message.payload))
		expect(payloads).toEqual(['oversized'])
		break
	}
	await expect.poll(() => grants).toEqual([1024n, 5000n])
	sendSecond.resolve()
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		let offsets = batch.map((message) => message.offset)
		expect(offsets).toEqual([1n])
		break
	}
	await expect.poll(() => grants).toEqual([1024n, 5000n, 600n])
})

test('returns the server response size once after all 100 message batches are delivered', async (tc) => {
	let maxBufferBytes = 8n * 1024n * 1024n
	let responseBytes = 10n * 1024n * 1024n
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: responseBytes,
						messages: Array.from({ length: 10_000 }, (_, index) => BigInt(index)).map(
							(offset) => ({
								offset,
								seqNo: offset + 1n,
								data: new Uint8Array([Number(offset % 256n)]),
							})
						),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c', maxBufferBytes })
	await expect.poll(() => reader.bufferedBytes).toBe(responseBytes)
	let deliveredBatches = 0
	for await (let batch of reader.read({ limit: 100, signal: tc.signal })) {
		expect(batch).toHaveLength(100)
		deliveredBatches++
		let lastBatch = deliveredBatches === 100
		expect(reader.bufferedBytes).toBe(lastBatch ? 0n : responseBytes)
		let expectedGrants = lastBatch ? [maxBufferBytes, responseBytes] : [maxBufferBytes]
		await expect.poll(() => grants).toEqual(expectedGrants)
		if (lastBatch) break
	}
	expect(deliveredBatches).toBe(100)
})

test('resumes a split response across partition groups without repeating messages or credit', async (tc) => {
	let revoke = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	let response = readResponse({
		partitionSessionId: 1n,
		bytesSize: 500n,
		messages: [0n, 1n].map((offset) => ({ offset, seqNo: offset + 1n, data: bytes('first') })),
	})
	let second = readResponse({
		partitionSessionId: 2n,
		messages: [0n, 1n, 2n].map((offset) => ({
			offset,
			seqNo: offset + 1n,
			data: bytes('second'),
		})),
	})
	if (
		response.serverMessage.case !== 'readResponse' ||
		second.serverMessage.case !== 'readResponse'
	) {
		throw new Error('Expected read response fixtures')
	}
	response.serverMessage.value.partitionData.push(second.serverMessage.value.partitionData[0]!)
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			let started = 0
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 11n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
				}
				if (clientMessage.case === 'startPartitionSessionResponse' && ++started === 2) {
					yield response
					await abortable(context.signal, revoke.promise)
					yield stopPartitionSession({ partitionSessionId: 1n })
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
		maxBufferBytes: 1000n,
		onPartitionSessionStop: async () => {
			stopped.resolve()
		},
	})
	for await (let batch of reader.read({ limit: 3, signal: tc.signal })) {
		let positions = batch.map((message) => [
			message.partitionSession.deref()?.partitionId,
			message.offset,
		])
		expect(positions).toEqual([
			[10n, 0n],
			[10n, 1n],
			[11n, 0n],
		])
		break
	}
	expect(reader.bufferedBytes).toBe(500n)
	expect(grants).toEqual([1000n])
	revoke.resolve()
	await stopped.promise
	for await (let batch of reader.read({ limit: 2, signal: tc.signal })) {
		let positions = batch.map((message) => [
			message.partitionSession.deref()?.partitionId,
			message.offset,
		])
		expect(positions).toEqual([
			[11n, 1n],
			[11n, 2n],
		])
		break
	}
	expect(reader.bufferedBytes).toBe(0n)
	await expect.poll(() => grants).toEqual([1000n, 500n])
})

test('rejects a batch when its codec destroys the reader during decoding', async (tc) => {
	let cancelled = Promise.withResolvers<void>()
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			context.signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						bytesSize: 300n,
						messages: [0n, 1n, 2n].map((offset) => ({
							offset,
							seqNo: offset + 1n,
							data: bytes(String(offset)),
						})),
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let reason = new Error('Stopped by codec')
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
		codecMap: new Map([
			[
				Codec.RAW,
				{
					codec: Codec.RAW,
					compress: (data) => data,
					decompress: (data) => {
						reader.destroy(reason)
						return data
					},
				},
			],
		]),
	})
	let iterator = reader.read({ limit: 2, signal: tc.signal })[Symbol.asyncIterator]()
	let next = iterator.next()
	await expect(next).rejects.toBe(reason)
	expect(reader.bufferedBytes).toBe(0n)
	await expect(cancelled.promise).resolves.toBeUndefined()
	expect(grants).toEqual([1000n])
	let nextRead = reader.read({ signal: tc.signal })[Symbol.asyncIterator]()
	let nextBatch = nextRead.next()
	await expect(nextBatch).rejects.toBe(reason)
})

test('releases response credit at the batch limit before a stopped trailing partition', async (tc) => {
	let stopped = Promise.withResolvers<void>()
	let response = readResponse({
		partitionSessionId: 1n,
		bytesSize: 300n,
		messages: [0n].map((offset) => ({ offset, seqNo: offset + 1n, data: bytes('live') })),
	})
	let second = readResponse({
		partitionSessionId: 2n,
		messages: [0n, 1n].map((offset) => ({
			offset,
			seqNo: offset + 1n,
			data: bytes('stopped'),
		})),
	})
	if (
		response.serverMessage.case !== 'readResponse' ||
		second.serverMessage.case !== 'readResponse'
	) {
		throw new Error('Expected read response fixtures')
	}
	response.serverMessage.value.partitionData.push(second.serverMessage.value.partitionData[0]!)
	let grants: bigint[] = []
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			let started = 0
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 11n })
				}
				if (clientMessage.case === 'readRequest') {
					grants.push(clientMessage.value.bytesSize)
				}
				if (clientMessage.case === 'startPartitionSessionResponse' && ++started === 2) {
					yield response
					yield stopPartitionSession({ partitionSessionId: 2n })
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
		maxBufferBytes: 1000n,
		onPartitionSessionStop: async () => {
			stopped.resolve()
		},
	})
	await stopped.promise
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		let positions = batch.map((message) => [
			message.partitionSession.deref()?.partitionId,
			message.offset,
		])
		expect(positions).toEqual([[10n, 0n]])
		break
	}
	expect(reader.bufferedBytes).toBe(0n)
	await expect.poll(() => grants).toEqual([1000n, 300n])
})
