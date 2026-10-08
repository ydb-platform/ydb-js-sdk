import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { type CompressionCodec, defaultCodecMap } from '../src/codec.ts'
import type { TopicMessage } from '../src/message.ts'
import { type TopicReader, createTopicReader } from '../src/reader/index.ts'
import { createTopicWriter } from '../src/writer/index.ts'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

let testTopicName: string
let testConsumerName: string
let testProducerName: string

beforeEach(async () => {
	testTopicName = `test-writer-parity-${Date.now()}`
	testConsumerName = `test-consumer-${Date.now()}`
	testProducerName = `test-producer-${Date.now()}`

	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: testTopicName,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 100n },
			consumers: [{ name: testConsumerName }],
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: testTopicName }))
})

let encode = function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

let decode = function decode(payload: Uint8Array): string {
	return new TextDecoder().decode(payload)
}

// Collect `count` messages from the reader, committing along the way. Bounded by
// the test timeout — an underdelivering topic fails the test there.
let readMessages = async function readMessages(
	reader: TopicReader,
	count: number
): Promise<TopicMessage[]> {
	let messages: TopicMessage[] = []
	for await (let batch of reader.read({ limit: count, batchWindowMs: 2000 })) {
		messages.push(...batch)
		await reader.commit(batch)
		if (messages.length >= count) {
			break
		}
	}
	return messages
}

test('writes with matching producer and messageGroupId', async (tc) => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		messageGroupId: testProducerName,
	})

	writer.write(encode('grouped-1'))
	writer.write(encode('grouped-2'))
	expect(await writer.flush(tc.signal)).toBe(2n)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let messages = await readMessages(reader, 2)
	expect(messages.map((message) => decode(message.payload))).toEqual(['grouped-1', 'grouped-2'])
	expect(messages.every((message) => message.producer === testProducerName)).toBe(true)
})

test('surfaces server BAD_REQUEST for messageGroupId without matching producer', async (tc) => {
	// With messageGroupId set and producer omitted the factory generates a random
	// producer id, so the InitRequest always carries producer_id != message_group_id
	// — a pair the server rejects at init. The documented-valid equal pair is
	// unreachable without also passing producer explicitly.
	let writer = createTopicWriter(driver, {
		topic: testTopicName,
		messageGroupId: 'group-a',
	})
	try {
		writer.write(encode('mismatched-pair'))
		let error = await writer.flush(tc.signal).then(() => null, (caught: unknown) => caught)
		expect(error).toBeInstanceOf(YDBError)
		expect((error as YDBError).code).toBe(StatusIds_StatusCode.BAD_REQUEST)
		expect((error as YDBError).message).toContain(
			'unsupported producer_id / message_group_id / partition_id settings in init request'
		)
	} finally {
		writer.destroy()
	}
})

test('rejects RAW writes into a GZIP-only topic terminally', { timeout: 20_000 }, async (tc) => {
	let path = `writer-parity-gzip-only-${Date.now()}`
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 1n },
			supportedCodecs: { codecs: [Codec.GZIP] },
		})
	)
	tc.onTestFinished(async () => {
		await topicService.dropTopic(create(DropTopicRequestSchema, { path }))
	})

	// Default codec is RAW — not in the topic's allowed set. The writer validates
	// the configured codec against InitResponse.supportedCodecs and fails at init
	// with an actionable error, before any WriteRequest reaches the wire.
	let writer = createTopicWriter(driver, { topic: path, producer: testProducerName })
	try {
		writer.write(encode('raw-into-gzip-only'))
		let error = await writer.flush(tc.signal).then(() => null, (caught: unknown) => caught)
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toMatch(/codec 1 .*supported codecs: 2/i)
		// The rejection is terminal: the writer is dead, not reconnecting.
		expect(() => writer.write(encode('after-error'))).toThrow(/cannot write messages/)
	} finally {
		writer.destroy()
	}
})

test(
	'fails the first writer terminally when a second writer takes over the producer',
	{ timeout: 30_000 },
	async (tc) => {
		let reconnecting: Array<{ attempt: number; error: unknown }> = []
		let errored: unknown[] = []
		let onReconnecting = (payload: unknown) => {
			let event = payload as { topic: string; attempt: number; error: unknown }
			if (event.topic === testTopicName) {
				reconnecting.push({ attempt: event.attempt, error: event.error })
			}
		}
		let onErrored = (payload: unknown) => {
			let event = payload as { topic: string; error: unknown }
			if (event.topic === testTopicName) {
				errored.push(event.error)
			}
		}
		subscribe('ydb:topic.writer.reconnecting', onReconnecting)
		subscribe('ydb:topic.writer.errored', onErrored)
		tc.onTestFinished(() => {
			unsubscribe('ydb:topic.writer.reconnecting', onReconnecting)
			unsubscribe('ydb:topic.writer.errored', onErrored)
		})

		let first = createTopicWriter(driver, { topic: testTopicName, producer: testProducerName })
		let second: ReturnType<typeof createTopicWriter> | undefined
		try {
			first.write(encode('a-1'))
			first.write(encode('a-2'))
			first.write(encode('a-3'))
			expect(await first.flush(tc.signal)).toBe(3n)

			// The second writer's init preempts the first one's session server-side,
			// and the recovered high-water mark continues the seqNo sequence at 4.
			second = createTopicWriter(driver, { topic: testTopicName, producer: testProducerName })
			second.write(encode('b-1'))
			expect(await second.flush(tc.signal)).toBe(4n)

			await new Promise((resolve) => setTimeout(resolve, 2000))

			// The kill arrives as a non-retryable BAD_REQUEST, so the preempted writer
			// dies terminally instead of reconnecting — a reconnect would preempt the
			// new session right back and the two writers would kill each other forever.
			expect(reconnecting).toHaveLength(0)
			expect(errored).toHaveLength(1)
			expect(errored[0]).toBeInstanceOf(YDBError)
			expect((errored[0] as YDBError).code).toBe(StatusIds_StatusCode.BAD_REQUEST)
			expect((errored[0] as YDBError).message).toContain(
				'ownership session is killed by another session'
			)

			expect(() => first.write(encode('a-4'))).toThrow(/cannot write messages/)
			await expect(first.flush(tc.signal)).rejects.toThrow(
				'ownership session is killed by another session'
			)

			// The surviving writer keeps working after the takeover.
			second.write(encode('b-2'))
			expect(await second.flush(tc.signal)).toBe(5n)
		} finally {
			first.destroy()
			second?.destroy()
		}
	}
)

test('round-trips metadataItems and createdAt through a real topic', async (tc) => {
	let createdAt = new Date('2024-05-06T07:08:09.123Z')

	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	writer.write(encode('no-meta'))
	writer.write(encode('one-pair'), {
		metadataItems: { 'trace-id': encode('abc-123') },
	})
	writer.write(encode('three-pairs'), {
		createdAt,
		metadataItems: {
			key1: encode('value-1'),
			key2: new Uint8Array([0, 1, 2, 255, 254]),
			key3: new Uint8Array(0),
		},
	})
	expect(await writer.flush(tc.signal)).toBe(3n)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let messages = await readMessages(reader, 3)
	expect(messages).toHaveLength(3)
	let [plain, onePair, threePairs] = messages

	// Byte-level comparison: the wire hands values back as Buffer views, which
	// toEqual would treat as a different type than the written Uint8Array.
	let toByteArrays = function toByteArrays(items: Record<string, Uint8Array>) {
		return Object.fromEntries(Object.entries(items).map(([key, value]) => [key, [...value]]))
	}

	expect(plain!.metadataItems).toBeUndefined()
	expect(toByteArrays(onePair!.metadataItems!)).toEqual({ 'trace-id': [...encode('abc-123')] })
	expect(toByteArrays(threePairs!.metadataItems!)).toEqual({
		key1: [...encode('value-1')],
		key2: [0, 1, 2, 255, 254],
		key3: [],
	})
	expect(threePairs!.createdAt).toBe(createdAt.getTime())
})

// Reversible XOR transform: a valid stand-in for a user compression codec in the
// custom id range [10000, 19999].
let xorTransform = function xorTransform(payload: Uint8Array): Uint8Array {
	let out = new Uint8Array(payload.length)
	for (let i = 0; i < payload.length; i++) {
		out[i] = payload[i]! ^ 0x5a
	}
	return out
}

let xorCodec: CompressionCodec = {
	codec: 10005,
	compress: xorTransform,
	decompress: xorTransform,
}

test('round-trips payloads through a registered custom codec', async (tc) => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		codec: xorCodec,
	})

	writer.write(encode('custom-codec-payload'))
	expect(await writer.flush(tc.signal)).toBe(1n)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
		codecMap: new Map([...defaultCodecMap, [10005, xorCodec]]),
	})

	let messages = await readMessages(reader, 1)
	// The wire batch must carry the registered custom codec id, not a built-in one.
	expect(messages[0]!.codec).toBe(10005)
	expect(decode(messages[0]!.payload)).toBe('custom-codec-payload')
})

test('fails reads of a custom codec without codecMap registration', async (tc) => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		codec: xorCodec,
	})
	writer.write(encode('custom-codec-payload'))
	expect(await writer.flush(tc.signal)).toBe(1n)

	let reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})
	try {
		let error: unknown
		try {
			await readMessages(reader, 1)
		} catch (caught) {
			error = caught
		}
		expect(String(error)).toContain('codec 10005')
		expect(String(error)).toContain('codecMap')
	} finally {
		reader.destroy()
	}
})

test('routes writes to the writer-level pinned partition', { timeout: 20_000 }, async (tc) => {
	let path = `writer-parity-partitions-${Date.now()}`
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path,
			partitioningSettings: { minActivePartitions: 2n, maxActivePartitions: 2n },
			consumers: [{ name: testConsumerName }],
		})
	)
	tc.onTestFinished(async () => {
		await topicService.dropTopic(create(DropTopicRequestSchema, { path }))
	})

	await using writerZero = createTopicWriter(driver, {
		topic: path,
		producer: `${testProducerName}-zero`,
		partitionId: 0n,
	})
	await using writerOne = createTopicWriter(driver, {
		topic: path,
		producer: `${testProducerName}-one`,
		partitionId: 1n,
	})

	writerZero.write(encode('to-partition-0-a'))
	writerZero.write(encode('to-partition-0-b'))
	writerOne.write(encode('to-partition-1-a'))
	writerOne.write(encode('to-partition-1-b'))
	expect(await writerZero.flush(tc.signal)).toBe(2n)
	expect(await writerOne.flush(tc.signal)).toBe(2n)

	await using reader = createTopicReader(driver, {
		topic: path,
		consumer: testConsumerName,
	})

	let byPartition = new Map<bigint, string[]>()
	for (let message of await readMessages(reader, 4)) {
		let partitionId = message.partitionSession.deref()!.partitionId
		let contents = byPartition.get(partitionId) ?? []
		contents.push(decode(message.payload))
		byPartition.set(partitionId, contents)
	}

	expect([...byPartition.keys()].sort()).toEqual([0n, 1n])
	expect(byPartition.get(0n)!.sort()).toEqual(['to-partition-0-a', 'to-partition-0-b'])
	expect(byPartition.get(1n)!.sort()).toEqual(['to-partition-1-a', 'to-partition-1-b'])
})
