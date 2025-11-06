import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { createTopicReader } from '../src/reader/index.js'
import { createTopicWriter } from '../src/writer/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

// Generate unique topic name for each test
let testTopicName: string
let testConsumerName: string

beforeEach(async () => {
	testTopicName = `test-topic-integration-${Date.now()}`
	testConsumerName = `test-consumer-${Date.now()}`

	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: testTopicName,
			partitioningSettings: {
				minActivePartitions: 1n,
				maxActivePartitions: 100n,
			},
			consumers: [
				{
					name: testConsumerName,
				},
			],
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(
		create(DropTopicRequestSchema, {
			path: testTopicName,
		})
	)
})

test('writes single message to topic', async () => {
	await using writer = createTopicWriter(driver, { topic: testTopicName })

	let seqNo = writer.write(new TextEncoder().encode('Hallo, YDB!'))
	expect(seqNo).toBeGreaterThan(0n)

	let lastSeqNo = await writer.flush()
	expect(lastSeqNo).toBeGreaterThan(0n)

	expect(seqNo).toBe(lastSeqNo)
})

test('messages written before initialization are properly renumbered', async () => {
	let producerId = `test-producer-${Date.now()}`

	// First writer: write messages to establish a sequence
	await using writer1 = createTopicWriter(driver, {
		topic: testTopicName,
		producer: producerId,
	})

	writer1.write(new TextEncoder().encode('Writer1 Message 1'))
	writer1.write(new TextEncoder().encode('Writer1 Message 2'))
	let writer1LastSeqNo = (await writer1.flush())!

	expect(writer1LastSeqNo).toBeGreaterThan(0n)

	// Wait a bit to ensure messages are committed on server
	await new Promise((resolve) => setTimeout(resolve, 500))

	writer1.destroy()

	// Create new writer with same producerId - should continue seqno sequence
	await using writer2 = createTopicWriter(driver, {
		topic: testTopicName,
		producer: producerId,
	})

	// Write messages immediately (before session initialization)
	// These should get seqno starting from writer1LastSeqNo + 1 after initialization
	writer2.write(new TextEncoder().encode('Writer2 Message 1'))
	writer2.write(new TextEncoder().encode('Writer2 Message 2'))
	let writer2LastSeqNo = (await writer2.flush())!

	// Verify seqno are sequential and continue from writer1
	// writer2 wrote 2 messages, so lastSeqNo should be writer1LastSeqNo + 2
	expect(writer2LastSeqNo).toBe(writer1LastSeqNo + 2n)

	// Verify messages were written correctly by reading them
	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let messagesRead = 0
	let foundSeqNos: bigint[] = []

	for await (let batch of reader.read({ limit: 10, waitMs: 2000 })) {
		for (let msg of batch) {
			foundSeqNos.push(msg.seqNo)
			messagesRead++
		}

		await reader.commit(batch)

		if (messagesRead >= 4) {
			break
		}
	}

	expect(messagesRead).toBeGreaterThanOrEqual(4)
	// Verify seqno are sequential - should start from 1 and continue
	foundSeqNos.sort((a, b) => Number(a - b))
	expect(foundSeqNos[0]!).toBe(1n)
	expect(foundSeqNos[foundSeqNos.length - 1]!).toBe(writer2LastSeqNo)
	// Verify writer2's messages continue from writer1
	expect(foundSeqNos).toContain(writer1LastSeqNo + 1n)
	expect(foundSeqNos).toContain(writer2LastSeqNo)
})
