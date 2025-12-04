import { afterEach, beforeEach, expect, inject, test } from 'vitest'
import * as v8 from 'node:v8'

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
	testTopicName = `test-topic-memory-${Date.now()}`
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

// oxlint-disable-next-line
test.skip('memory leak check', { timeout: 300_000 }, async () => {
	let initialMemory = process.memoryUsage().heapUsed
	let iterations = 50_000

	let snapshotPath = v8.writeHeapSnapshot()
	console.log(`Heap snapshot written to: ${snapshotPath}`)

	for (let i = 0; i < iterations; i++) {
		await using reader = createTopicReader(driver, {
			topic: testTopicName,
			consumer: testConsumerName,
		})

		try {
			// oxlint-disable-next-line no-await-in-loop
			for await (let messages of reader.read({
				signal: AbortSignal.timeout(1), // Very short timeout to trigger more errors
			})) {
				// oxlint-disable-next-line no-await-in-loop
				await reader.commit(messages)
			}
		} catch {
			// Ignore timeout errors
		}

		if (i % 5_000 === 0) {
			if (global.gc) {
				global.gc()
			}

			let finalMemory = process.memoryUsage().heapUsed
			let diff = finalMemory - initialMemory

			console.log(`Memory diff (i=${i}): ${diff / 1024 / 1024} MB`)
		}
	}

	if (global.gc) {
		global.gc()
	}

	let finalMemory = process.memoryUsage().heapUsed
	let diff = finalMemory - initialMemory

	console.log(`Memory diff: ${diff / 1024 / 1024} MB`)
	snapshotPath = v8.writeHeapSnapshot()
	console.log(`Heap snapshot written to: ${snapshotPath}`)

	// Allow some fluctuation, but it shouldn't be massive
	// 10MB is a generous buffer for 100 iterations if there's no leak
	expect(diff).toBeLessThan(10 * 1024 * 1024)
})
