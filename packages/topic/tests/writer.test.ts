import { afterEach, beforeEach, expect, inject, test } from 'vitest'
import { create } from '@bufbuild/protobuf'

import { Driver } from '@ydbjs/core'
import { CreateTopicRequestSchema, DropTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'

import { createTopicWriter } from '../src/writer/index.ts'

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
	using writer = createTopicWriter(driver, { topic: testTopicName })

	writer.write(new TextEncoder().encode('Hallo, YDB!'))

	let lastSeqNo = await writer.flush()
	expect(lastSeqNo).toBeGreaterThan(0n)
})
