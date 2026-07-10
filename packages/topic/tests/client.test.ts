import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { topic } from '../src/index.js'

// The rest of this package's tests exercise createTopicReader/createTopicWriter
// directly from their subpaths — none of them go through the public `topic()`
// facade from the main entry point, so it had zero integration coverage.
let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

let testTopicName: string
let testConsumerName: string

beforeEach(async () => {
	testTopicName = `test-topic-client-${Date.now()}`
	testConsumerName = `test-consumer-${Date.now()}`

	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: testTopicName,
			partitioningSettings: {
				minActivePartitions: 1n,
				maxActivePartitions: 100n,
			},
			consumers: [{ name: testConsumerName }],
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: testTopicName }))
})

test('writes and reads a message end to end through the facade', async () => {
	let client = topic(driver)

	await using writer = client.createWriter({ topic: testTopicName })
	writer.write(new TextEncoder().encode('Hello via facade'))
	// write() is void; flush() returns the last acknowledged seqNo.
	let seqNo = await writer.flush()

	await using reader = client.createReader({
		topic: testTopicName,
		consumer: testConsumerName,
	})

	for await (let batch of reader.read({ limit: 1, batchWindowMs: 2000 })) {
		expect(batch).toHaveLength(1)
		expect(batch[0]!.seqNo).toBe(seqNo)
		await reader.commit(batch)
		return
	}
})
