import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import {
	CreateTopicRequestSchema,
	DescribeConsumerRequestSchema,
	DescribeConsumerResultSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import type { TopicMessage } from '../src/message.js'
import { type TopicReader, createTopicReader } from '../src/reader/index.js'
import { createTopicWriter } from '../src/writer/index.js'

// Real-YDB parity coverage for reader behaviour other SDKs pin with live tests:
// multi-topic sources, readFrom / partitionIds init settings, commit durability
// across reader restarts, and the onPartitionSessionStart readOffset override.

let driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

let seq = 0
let consumerName: string
let createdTopics: string[]

beforeEach(() => {
	seq += 1
	consumerName = `consumer-parity-${Date.now()}-${seq}`
	createdTopics = []
})

afterEach(async () => {
	for (let path of createdTopics) {
		// oxlint-disable-next-line no-await-in-loop
		await topicService.dropTopic(create(DropTopicRequestSchema, { path })).catch(() => {})
	}
})

let makeTopic = async function makeTopic(suffix: string, partitions = 1n): Promise<string> {
	let path = `topic-parity-${suffix}-${Date.now()}-${seq}`
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path,
			partitioningSettings: {
				minActivePartitions: partitions,
				maxActivePartitions: partitions,
			},
			consumers: [{ name: consumerName }],
		})
	)
	createdTopics.push(path)
	return path
}

let writeBytes = async function writeBytes(
	topic: string,
	bytes: number[],
	options?: { producer?: string; partitionId?: bigint }
): Promise<void> {
	await using writer = createTopicWriter(driver, {
		topic,
		producer: options?.producer ?? 'p',
		...(options?.partitionId !== undefined && { partitionId: options.partitionId }),
	})
	for (let byte of bytes) {
		writer.write(new Uint8Array([byte]))
	}
	await writer.flush()
}

test('confirms a start-session commit override and retains it for the next reader', async (tc) => {
	let topic = await makeTopic('commit-override')
	await using writer = createTopicWriter(driver, { topic, producer: 'p' })
	for (let value of [0, 1, 2]) {
		writer.write(new Uint8Array([value]))
	}
	await writer.flush(tc.signal)
	let confirmed: bigint[] = []
	await using reader = createTopicReader(driver, {
		topic,
		consumer: consumerName,
		onPartitionSessionStart: async () => ({ readOffset: 2n, commitOffset: 2n }),
		onCommittedOffset: (_, offset) => {
			confirmed.push(offset)
		},
	})
	await expect.poll(() => confirmed, { timeout: 10_000 }).toEqual([2n])
	await reader.close()
	let restartedOffset: bigint | undefined
	await using restarted = createTopicReader(driver, {
		topic,
		consumer: consumerName,
		onPartitionSessionStart: async (_, committed) => {
			restartedOffset = committed
		},
	})
	for await (let batch of restarted.read({ limit: 1, signal: tc.signal })) {
		expect(restartedOffset).toBe(2n)
		expect(batch[0]!.offset).toBe(2n)
		break
	}
})

let waitUntil = async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
	let started = Date.now()
	while (Date.now() - started < ms) {
		if (predicate()) return true
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	return predicate()
}

let committedOffset = async function committedOffset(topic: string): Promise<bigint> {
	let response = await topicService.describeConsumer(
		create(DescribeConsumerRequestSchema, {
			path: topic,
			consumer: consumerName,
			includeStats: true,
		})
	)
	let result = anyUnpack(response.operation!.result!, DescribeConsumerResultSchema)
	let stats = result?.partitions.find((p) => p.partitionId === 0n)?.partitionConsumerStats
	return stats?.committedOffset ?? 0n
}

// Polls describeConsumer until partition 0's committed offset reaches `expected`
// (or the window ends), returning the last observed value.
let waitForCommitted = async function waitForCommitted(
	topic: string,
	expected: bigint,
	ms: number
): Promise<bigint> {
	let started = Date.now()
	let value = await committedOffset(topic)
	while (value !== expected && Date.now() - started < ms) {
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 200))
		// oxlint-disable-next-line no-await-in-loop
		value = await committedOffset(topic)
	}
	return value
}

let readInBackground = function readInBackground(
	reader: TopicReader,
	sink: TopicMessage[],
	signal: AbortSignal
): void {
	void (async () => {
		try {
			for await (let batch of reader.read({ batchWindowMs: 200, signal })) {
				sink.push(...batch)
			}
		} catch {
			// reader closed / signal aborted at teardown
		}
	})()
}

// Partition state is keyed by (topicPath, partitionId): partition 0 of each
// topic keeps its own entry and session on the shared stream, both topics'
// messages are delivered, and each commit advances its own topic's consumer
// offset.
test(
	'delivers messages from both topics to a multi-topic reader',
	{ timeout: 30_000 },
	async (tc) => {
		let topicA = await makeTopic('multi-a')
		let topicB = await makeTopic('multi-b')
		await writeBytes(topicA, [1])
		await writeBytes(topicB, [2])

		await using reader = createTopicReader(driver, {
			topic: [{ path: topicA }, { path: topicB }],
			consumer: consumerName,
			gracefulShutdownTimeoutMs: 5_000,
		})

		let received: TopicMessage[] = []
		readInBackground(reader, received, tc.signal)

		let byTopic = new Map<string, TopicMessage>()
		let collect = function collect(): boolean {
			for (let message of received) {
				let path = message.partitionSession.deref()?.topicPath
				if (path !== undefined && !byTopic.has(path)) {
					byTopic.set(path, message)
				}
			}
			return byTopic.size === 2
		}
		await waitUntil(collect, 8_000)
		expect(byTopic.size).toBe(2)

		await reader.commit([...byTopic.values()])
		await reader.close()
		expect(await waitForCommitted(topicA, 1n, 5_000)).toBe(1n)
		expect(await waitForCommitted(topicB, 1n, 5_000)).toBe(1n)
	}
)

test('skips messages written before readFrom', { timeout: 30_000 }, async (tc) => {
	let topic = await makeTopic('read-from')

	await using writer = createTopicWriter(driver, { topic, producer: 'p' })
	for (let byte of [1, 2, 3]) {
		writer.write(new Uint8Array([byte]))
	}
	await writer.flush()

	// written_at is server-assigned — leave clear air on both sides of the cutoff
	// so clock skew between the test and the server cannot flip the filter.
	await new Promise((resolve) => setTimeout(resolve, 3_000))
	for (let byte of [4, 5, 6]) {
		writer.write(new Uint8Array([byte]))
	}
	await writer.flush()
	let cutoff = new Date(Date.now() - 1_500)

	await using reader = createTopicReader(driver, {
		topic: { path: topic, readFrom: cutoff },
		consumer: consumerName,
	})

	let received: TopicMessage[] = []
	readInBackground(reader, received, tc.signal)

	await waitUntil(() => received.length >= 3, 10_000)
	// Give any over-delivery of the pre-cutoff batch time to surface.
	await new Promise((resolve) => setTimeout(resolve, 500))
	expect(received.map((message) => message.payload[0]).toSorted((a, b) => a! - b!)).toEqual([
		4, 5, 6,
	])
})

test('delivers only partitions listed in partitionIds', { timeout: 30_000 }, async (tc) => {
	let topic = await makeTopic('partition-filter', 2n)
	await writeBytes(topic, [10], { producer: 'p0', partitionId: 0n })
	await writeBytes(topic, [20], { producer: 'p1', partitionId: 1n })

	await using reader = createTopicReader(driver, {
		topic: { path: topic, partitionIds: [1n] },
		consumer: consumerName,
	})

	let received: TopicMessage[] = []
	readInBackground(reader, received, tc.signal)

	await waitUntil(() => received.length >= 1, 10_000)
	// Give any delivery from the filtered-out partition time to surface.
	await new Promise((resolve) => setTimeout(resolve, 500))
	expect(received.map((message) => message.payload[0])).toEqual([20])
	expect(received[0]!.partitionSession.deref()?.partitionId).toBe(1n)
})

test(
	'resumes delivery from the committed offset after reader restart',
	{ timeout: 30_000 },
	async (tc) => {
		let topic = await makeTopic('commit-restart')
		await writeBytes(topic, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

		await using reader1 = createTopicReader(driver, { topic, consumer: consumerName })
		let delivered: TopicMessage[] = []
		for await (let batch of reader1.read({ batchWindowMs: 300, signal: tc.signal })) {
			delivered.push(...batch)
			if (delivered.length >= 5) {
				break
			}
		}
		expect(delivered[0]!.offset).toBe(0n)
		await reader1.commit(delivered.slice(0, 5))
		await reader1.close()

		expect(await waitForCommitted(topic, 5n, 5_000)).toBe(5n)

		await using reader2 = createTopicReader(driver, { topic, consumer: consumerName })
		for await (let batch of reader2.read({ batchWindowMs: 300, signal: tc.signal })) {
			if (batch.length === 0) {
				continue
			}
			// Delivery must resume exactly at the committed offset — message 5, not a
			// redelivery of the already-committed prefix.
			expect(batch[0]!.offset).toBe(5n)
			expect(batch[0]!.payload[0]).toBe(5)
			return
		}
	}
)

test(
	'starts delivery at the readOffset returned by onPartitionSessionStart',
	{ timeout: 30_000 },
	async (tc) => {
		let topic = await makeTopic('offset-override')
		await writeBytes(topic, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

		await using reader = createTopicReader(driver, {
			topic,
			consumer: consumerName,
			onPartitionSessionStart: async () => ({ readOffset: 7n }),
		})

		let received: TopicMessage[] = []
		readInBackground(reader, received, tc.signal)

		await waitUntil(() => received.length >= 3, 10_000)
		// Give any delivery below the override time to surface.
		await new Promise((resolve) => setTimeout(resolve, 500))
		expect(received.map((message) => message.offset)).toEqual([7n, 8n, 9n])
	}
)
