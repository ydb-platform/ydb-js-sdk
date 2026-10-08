import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'

import { create, toBinary } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	StreamReadMessage_FromServerSchema,
	StreamReadMessage_ReadResponseSchema,
} from '@ydbjs/api/topic'
import { expect, test, vi } from 'vitest'

import { GZIP_CODEC } from '../codec.ts'
import type { TopicPartitionSession } from '../partition-session.ts'
import { TopicReader } from './reader.ts'
import { ReaderTransport } from './transport.ts'
import {
	failureResponse,
	initResponse,
	makeFakeTopicDriver,
	makeFakeTx,
	readResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'

// FinalizationRegistry observes reclamation without deref() keeping a target alive
// in the GC job. The test retains the reader, so dropping that object cannot pass it.
let collectGarbage = async function collectGarbage(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await delay(1)
		globalThis.gc!()
		// oxlint-disable-next-line no-await-in-loop
		await delay(1)
	}
}

let memoryProbe = function memoryProbe(
	registry: FinalizationRegistry<string>,
	calls: string[],
	id: string
) {
	let retained = new Uint8Array(32 * 1024)
	registry.register(retained, id)
	return () => calls.push(`${id}:${retained.byteLength}`)
}

let startHook = function startHook(registry: FinalizationRegistry<string>, probe: () => unknown) {
	let grants = 0
	return async (session: TopicPartitionSession) => {
		probe()
		registry.register(session, `session-${grants++}`)
	}
}

let stopHook = function stopHook(probe: () => unknown) {
	return async () => {
		probe()
	}
}

let retainedCodec = function retainedCodec(probe: () => unknown) {
	return {
		codec: Codec.RAW,
		compress: (data: Uint8Array) => data,
		decompress: (data: Uint8Array) => {
			probe()
			return data
		},
	}
}

let bufferedReader = async function bufferedReader(
	count = 2,
	tx?: ReturnType<typeof makeFakeTx>['tx']
) {
	let reclaimed = new Set<string>()
	let registry = new FinalizationRegistry<string>((id) => reclaimed.add(id))
	let calls: string[] = []
	let fake = makeFakeTopicDriver()
	let reader = new TopicReader(
		fake.driver,
		{
			topic: '/t',
			consumer: 'c',
			codecMap: new Map([[Codec.RAW, retainedCodec(memoryProbe(registry, calls, 'codec'))]]),
			onPartitionSessionStart: startHook(
				registry,
				memoryProbe(registry, calls, 'start-hook')
			),
			onPartitionSessionStop: stopHook(memoryProbe(registry, calls, 'stop-hook')),
			onCommittedOffset: memoryProbe(registry, calls, 'commit-hook'),
		},
		tx ? { tx } : undefined
	)
	let stream = await fake.waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse())
	await stream.waitForReadRequest()
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await stream.waitForStartResponse()
	if (count > 0) {
		stream.respond(
			readResponse({
				partitionSessionId: 1n,
				bytesSize: BigInt(count * 256 * 1024),
				messages: Array.from({ length: count }, (_, i) => {
					let data = new Uint8Array(256 * 1024)
					registry.register(data, `payload-${i}`)
					return { offset: BigInt(i), seqNo: BigInt(i + 1), data }
				}),
			})
		)
	}
	await settle()
	return { reader, stream, fake, reclaimed, registry, calls }
}

let readOne = async function readOne(reader: TopicReader, signal: AbortSignal): Promise<void> {
	for await (let batch of reader.read({ limit: 1, signal })) {
		expect(batch).toHaveLength(1)
		break
	}
}

let readTail = async function readTail(
	reader: TopicReader,
	signal: AbortSignal
): Promise<bigint[]> {
	let offsets: bigint[] = []
	for await (let batch of reader.read({ signal })) {
		offsets.push(...batch.map((message) => message.offset!))
	}
	return offsets
}

// Server packet boundaries and compression ratios must be fixed to distinguish
// encoded read credit from decoded retention independently of YDB batching.
test('decodes only requested messages from a compressed response', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let decodedBytes = 0
	using reader = new TopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 65536n,
		codecMap: new Map([
			[
				Codec.GZIP,
				{
					...GZIP_CODEC,
					decompress(data) {
						let decoded = GZIP_CODEC.decompress(data)
						decodedBytes += decoded.byteLength
						return decoded
					},
				},
			],
		]),
	})
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse())
	await stream.waitForReadRequest()
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
	await stream.waitForStartResponse()
	let data = gzipSync(new Uint8Array(256 * 1024))
	let response = create(
		StreamReadMessage_FromServerSchema,
		readResponse({
			partitionSessionId: 1n,
			codec: Codec.GZIP,
			bytesSize: 0n,
			messages: Array.from({ length: 64 }, (_, i) => ({
				offset: BigInt(i),
				seqNo: BigInt(i + 1),
				data,
			})),
		})
	)
	if (response.serverMessage.case !== 'readResponse') throw new Error('Expected read response')
	for (let partition of response.serverMessage.value.partitionData) {
		for (let batch of partition.batches) {
			for (let message of batch.messageData) message.uncompressedSize = 262144n
		}
	}
	let bytesSize = BigInt(
		toBinary(StreamReadMessage_ReadResponseSchema, response.serverMessage.value).length
	)
	response.serverMessage.value.bytesSize = bytesSize
	expect(bytesSize).toBeLessThan(65536n)
	stream.respond(response)
	await settle()
	expect(decodedBytes).toBe(0)
	await readOne(reader, tc.signal)
	expect(decodedBytes).toBe(262144)
	expect(reader.bufferedBytes).toBe(bytesSize)
	expect(stream.sent.filter((frame) => frame.clientMessage.case === 'readRequest')).toHaveLength(
		1
	)
})

test('releases unread payloads and callbacks after destroy while the reader is retained', async () => {
	let fixture = await bufferedReader()
	using reader = fixture.reader
	reader.destroy(new Error('Hard stop'))
	await settle()
	await collectGarbage()
	expect(fixture.reclaimed).toEqual(
		new Set([
			'payload-0',
			'payload-1',
			'session-0',
			'start-hook',
			'stop-hook',
			'commit-hook',
			'codec',
		])
	)
	expect(reader.bufferedBytes).toBe(0n)
})

test('releases unread payloads after a fatal server status', async () => {
	let fixture = await bufferedReader()
	using reader = fixture.reader
	fixture.stream.respond(failureResponse(StatusIds_StatusCode.UNAUTHORIZED))
	await settle()
	await expect(reader.read()[Symbol.asyncIterator]().next()).rejects.toBeDefined()
	await collectGarbage()
	expect(fixture.reclaimed.has('payload-0')).toBe(true)
	expect(fixture.reclaimed.has('payload-1')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('reclaims an active partition after an internal commit effect fails', async (tc) => {
	let fixture = await bufferedReader(1)
	using reader = fixture.reader
	let reason = new Error('Injected commit send failure')
	for await (let batch of reader.read({ signal: tc.signal })) {
		using send = vi.spyOn(ReaderTransport.prototype, 'send').mockImplementation(() => {
			throw reason
		})
		await expect(reader.commit(batch)).rejects.toBe(reason)
		expect(send).toHaveBeenCalledTimes(1)
		break
	}
	await settle()
	await collectGarbage()
	expect(fixture.reclaimed.has('session-0')).toBe(true)
	expect(fixture.stream.wasAborted()).toBe(true)
	await expect(reader.close()).rejects.toBe(reason)
})

test('releases unread carry after a split read is destroyed', async (tc) => {
	let fixture = await bufferedReader()
	using reader = fixture.reader
	await readOne(reader, tc.signal)
	reader.destroy(new Error('Hard stop'))
	await settle()
	await collectGarbage()
	expect(fixture.reclaimed.has('payload-0')).toBe(true)
	expect(fixture.reclaimed.has('payload-1')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('releases unread messages while a destroyed iterator remains suspended at yield', async (tc) => {
	let fixture = await bufferedReader()
	using reader = fixture.reader
	let iterator = reader.read({ limit: 1, signal: tc.signal })[Symbol.asyncIterator]()
	let first = await iterator.next()
	try {
		reader.destroy(new Error('Hard stop'))
		await settle()
		await collectGarbage()
		expect(fixture.reclaimed.has('payload-1')).toBe(true)
		expect(first.value?.[0]?.payload.byteLength).toBe(256 * 1024)
		expect(reader.bufferedBytes).toBe(0n)
	} finally {
		await iterator.return?.()
	}
})

test('does not restore a buffered read window after a hard stop', async () => {
	let fixture = await bufferedReader()
	using reader = fixture.reader
	let reason = new Error('Hard stop')
	let iterator = reader.read({ batchWindowMs: 60_000 })[Symbol.asyncIterator]()
	let next = iterator.next().catch((error: unknown) => error)
	await settle()
	reader.destroy(reason)
	expect(await next).toBe(reason)
	await collectGarbage()
	expect(fixture.reclaimed.has('payload-0')).toBe(true)
	expect(fixture.reclaimed.has('payload-1')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('rejects a queued read result when destroy wins before its continuation', async () => {
	let fixture = await bufferedReader()
	using reader = fixture.reader
	let reason = new Error('Hard stop')
	let iterator = reader.read()[Symbol.asyncIterator]()
	let next = iterator.next().catch((error: unknown) => error)
	reader.destroy(reason)
	expect(await next).toBe(reason)
	await collectGarbage()
	expect(fixture.reclaimed.has('payload-0')).toBe(true)
	expect(fixture.reclaimed.has('payload-1')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('keeps a cleanly closed tail readable across GC and releases it after reading', async (tc) => {
	let fixture = await bufferedReader()
	using reader = fixture.reader
	await reader.close()
	await collectGarbage()
	expect(fixture.reclaimed.has('payload-0')).toBe(false)
	expect(fixture.reclaimed.has('codec')).toBe(false)
	expect(fixture.reclaimed.has('start-hook')).toBe(true)
	expect(fixture.reclaimed.has('stop-hook')).toBe(true)
	expect(fixture.reclaimed.has('commit-hook')).toBe(true)
	expect(await readTail(reader, tc.signal)).toEqual([0n, 1n])
	await collectGarbage()
	expect(fixture.reclaimed.has('payload-0')).toBe(true)
	expect(fixture.reclaimed.has('payload-1')).toBe(true)
	expect(fixture.reclaimed.has('codec')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('clears transaction offsets on rollback after the reader was cleanly closed', async (tc) => {
	let tx = makeFakeTx()
	let fixture = await bufferedReader(1, tx.tx)
	using reader = fixture.reader
	await readOne(reader, tc.signal)
	await reader.close()
	await tx.rollback(new Error('Rollback'))
	await tx.close(false)
	await collectGarbage()
	expect(fixture.reclaimed.has('session-0')).toBe(true)
	expect(fixture.reclaimed.has('start-hook')).toBe(true)
	expect(fixture.reclaimed.has('codec')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('clears transaction offsets after successful transaction finalization', async (tc) => {
	let tx = makeFakeTx()
	let fixture = await bufferedReader(1, tx.tx)
	using reader = fixture.reader
	await readOne(reader, tc.signal)
	await tx.commit()
	await tx.close(true)
	await collectGarbage()
	expect(fixture.reclaimed.has('session-0')).toBe(true)
	expect(fixture.reclaimed.has('start-hook')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('preserves delivered transaction offsets after a clean close followed by disposal', async (tc) => {
	let tx = makeFakeTx()
	let fixture = await bufferedReader(2, tx.tx)
	using reader = fixture.reader
	await readOne(reader, tc.signal)
	await reader.close()
	reader[Symbol.dispose]()
	await expect(reader.close()).resolves.toBeUndefined()
	await tx.commit()
	expect(fixture.fake.txOffsetRequests).toHaveLength(1)
	expect(fixture.fake.txOffsetRequests[0]!.topics[0]!.partitions[0]!.partitionOffsets).toEqual([
		expect.objectContaining({ start: 0n, end: 1n }),
	])
	await tx.close(true)
	await collectGarbage()
	expect(fixture.reclaimed.has('payload-1')).toBe(true)
	expect(fixture.reclaimed.has('session-0')).toBe(true)
	expect(reader.bufferedBytes).toBe(0n)
})

test('reclaims stopped partitions without pending commits while the reader stays live', async () => {
	let fixture = await bufferedReader(0)
	using reader = fixture.reader
	fixture.stream.respond(stopPartitionSession({ partitionSessionId: 1n }))
	for (let i = 1; i < 32; i++) {
		fixture.stream.respond(
			startPartitionSession({ partitionSessionId: BigInt(i + 1), partitionId: BigInt(i) })
		)
		// oxlint-disable-next-line no-await-in-loop
		await settle()
		fixture.stream.respond(stopPartitionSession({ partitionSessionId: BigInt(i + 1) }))
		// oxlint-disable-next-line no-await-in-loop
		await settle()
	}
	await collectGarbage()
	expect(
		Array.from(fixture.reclaimed).filter((id) => id.startsWith('session-')).length
	).toBeGreaterThanOrEqual(31)
	expect(reader.bufferedBytes).toBe(0n)
})
