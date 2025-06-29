import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import { CreateTopicRequestSchema, DropTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { TopicReader } from '../src/reader.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false
})
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

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

test('reads single message from topic', async () => {
	await using reader = new TopicReader(driver, { topic: testTopicName, consumer: testConsumerName })

	for await (let batch of reader.read({ limit: 1, waitMs: 100 })) {
		// Process each batch of messages
		expect(Array.isArray(batch)).toBe(true)

		return
	}
})
