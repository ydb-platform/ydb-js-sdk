import { afterEach, assert, beforeEach, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { linkSignals } from '@ydbjs/abortable'
import { createTopicReader } from '@ydbjs/topic/reader'
import { createTopicWriter } from '@ydbjs/topic/writer'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { create } from '@bufbuild/protobuf'
import { once } from 'node:events'

// #region setup
declare module 'vitest' {
	export interface ProvidedContext {
		connectionString: string
	}
}

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})

await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

let testTopicName: string
let testProducerName: string
let testConsumerName: string

beforeEach(async () => {
	testTopicName = `test-topic-integration-${Date.now()}`
	testProducerName = `test-producer-${Date.now()}`
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
// #endregion

test('writes and reads messages from a topic', async () => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	writer.write(Buffer.from('Hello, world!', 'utf-8'))
	await writer.flush()

	for await (let batch of reader.read()) {
		assert.equal(batch.length, 1, 'Expected one message in batch')
		assert.equal(Buffer.from(batch[0]!.payload).toString('utf-8'), 'Hello, world!')
		await reader.commit(batch)
		break
	}
})

// oxlint-disable-next-line expect-expect
test('writes and reads concurrently', { timeout: 60_000 }, async (tc) => {
	let BATCH_SIZE = 1024
	let MESSAGE_SIZE = 16 * 1024
	let TOTAL_BATCHES = 16
	let TOTAL_TRAFFIC = TOTAL_BATCHES * BATCH_SIZE * MESSAGE_SIZE

	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		maxInflightCount: TOTAL_BATCHES * BATCH_SIZE,
	})

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
		maxBufferBytes: BigInt(TOTAL_TRAFFIC),
	})

	let wb = 0
	let rb = 0
	let ctrl = new AbortController()
	// linkSignals, not AbortSignal.any (composite signals accumulate listeners).
	using combined = linkSignals(tc.signal, ctrl.signal, AbortSignal.timeout(25_000))
	let signal = combined.signal

	// Producer.
	void (async () => {
		while (wb < TOTAL_TRAFFIC) {
			if (signal.aborted) break

			for (let i = 0; i < BATCH_SIZE; i++) {
				writer.write(Buffer.alloc(MESSAGE_SIZE))
			}

			wb += MESSAGE_SIZE * BATCH_SIZE
		}

		let start = performance.now()
		await writer.flush()
		console.log(`write took ${performance.now() - start} ms`)
	})()

	// Consumer.
	void (async () => {
		for await (let batch of reader.read({ signal })) {
			let promise = reader.commit(batch)
			rb += MESSAGE_SIZE * batch.length

			// >=, not ==: at-least-once redelivery can overshoot the total, and an
			// exact-equality trigger would then never fire and hang the test.
			if (rb >= TOTAL_TRAFFIC) {
				await promise
				ctrl.abort()
				break
			}
		}
	})()

	let start = Date.now()
	await once(ctrl.signal, 'abort')
	await writer.close()
	await reader.close()

	assert.ok(rb >= TOTAL_TRAFFIC, 'read at least all written traffic')
	console.log(`wrote ${wb} bytes and read ${rb} bytes in ${Date.now() - start} ms.`)
})
