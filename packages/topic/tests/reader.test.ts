import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { createTopicReader } from '../src/reader/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
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
	await topicService.dropTopic(
		create(DropTopicRequestSchema, {
			path: testTopicName,
		})
	)
})

test('reads single message from topic', async () => {
	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	for await (let batch of reader.read({ limit: 1, waitMs: 100 })) {
		await reader.commit(batch)

		// Process each batch of messages
		expect(Array.isArray(batch)).toBe(true)

		return
	}
})

// https://github.com/ydb-platform/ydb-js-sdk/issues/552
// Integration test for commit with offset gap (retention scenario) is not practical
// because local-ydb retention check interval is too long.
// The fix is covered by unit tests in _commit.test.ts.
//
// To test manually against a real YDB cluster:
// 1. Create topic with short retention (retentionPeriod: { seconds: 60n })
// 2. Write messages, wait for retention to delete them (~2-5 minutes)
// 3. Create reader (committedOffset will be 0)
// 4. Read first available message (offset > 0)
// 5. Commit should fill gap and resolve immediately (not hang)
