import { afterEach, beforeEach, expect, inject, test } from 'vitest'
import { create } from '@bufbuild/protobuf'

import { Driver } from '@ydbjs/core'
import { CreateTopicRequestSchema, DropTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'

import { createTopicWriter } from '../src/writer/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false
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
	await topicService.dropTopic(create(DropTopicRequestSchema, {
		path: testTopicName,
	}))
})

test('writes single message to topic', async () => {
	using writer = createTopicWriter(driver, {
		topic: testTopicName,
		// Important: Set small flushIntervalMs for tests to ensure timely acks and avoid hanging tests
		flushIntervalMs: 100,
	})

	let seqNo = await writer.write(new TextEncoder().encode('Hallo, YDB!'))
	expect(seqNo).toBeGreaterThan(0n)
})

test('topic writer performance', async () => {
	let MESSAGE_SIZE = 64 * 1024
	let MESSAGE_COUNT = 1024 * 1024 * 1024 / MESSAGE_SIZE
	let payload = new Uint8Array(MESSAGE_SIZE)
	crypto.getRandomValues(payload)

	let allAcked = Promise.withResolvers<void>()

	let skippedAcks: Set<bigint> = new Set();
	let writtenAcks: Set<bigint> = new Set();

	using writer = createTopicWriter(driver, {
		topic: testTopicName,
		flushIntervalMs: 10,
		maxBufferBytes: 1024n * 1024n * 256n, // 256MB
		maxInflightCount: 4096,
		onAck: (seqNo, status) => {
			if (status === 'skipped') {
				skippedAcks.add(seqNo);
			} else {
				writtenAcks.add(seqNo);
			}

			if (writtenAcks.size >= MESSAGE_COUNT) {
				allAcked.resolve();
			}
		}
	})

	await new Promise((resolve) => {
		setTimeout(resolve, 1000)
	})

	for (let i = 0; i < MESSAGE_COUNT; i++) {
		writer.write(payload)
	}

	let start = Date.now()
	await allAcked.promise
	let end = Date.now()

	let bpms = (MESSAGE_COUNT * payload.length) / (end - start)
	expect(bpms).toBeGreaterThan(128 * 1024)
}, { timeout: 30000 })
