import { afterEach, assert, beforeEach, inject, test } from "vitest";
import { Driver } from '@ydbjs/core'
import { createTopicReader } from '@ydbjs/topic/reader'
import { createTopicWriter } from '@ydbjs/topic/writer'
import { CreateTopicRequestSchema, DropTopicRequestSchema, TopicServiceDefinition } from "@ydbjs/api/topic";
import { create } from "@bufbuild/protobuf";
import { once } from "node:events";

// #region setup
declare module 'vitest' {
	export interface ProvidedContext {
		connectionString: string
	}
}

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false
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
	await topicService.dropTopic(create(DropTopicRequestSchema, {
		path: testTopicName,
	}))
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

	// Write a message to the topic
	writer.write(Buffer.from('Hello, world!', "utf-8"))

	await writer.flush()

	// Read the message from the topic
	for await (let batch of reader.read()) {
		assert.equal(batch.length, 1, 'Expected one message in batch');
		let message = batch[0]!;
		assert.equal(Buffer.from(message.payload).toString('utf-8'), 'Hello, world!')

		await reader.commit(batch)

		break
	}
});

test('writes and reads concurrently', { timeout: 60_000 }, async (tc) => {
	const BATCH_SIZE = 1024;
	const MESSAGE_SIZE = 16 * 1024;
	const TOTAL_BATCHES = 16;
	const TOTAL_TRAFFIC = TOTAL_BATCHES * BATCH_SIZE * MESSAGE_SIZE;

	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		maxInflightCount: TOTAL_BATCHES * BATCH_SIZE
	})

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
		maxBufferBytes: BigInt(TOTAL_TRAFFIC),
	})

	let wb = 0
	let rb = 0
	let ctrl = new AbortController()
	let signal = AbortSignal.any([tc.signal, ctrl.signal, AbortSignal.timeout(25_000)])

	// Write messages to the topic
	void (async () => {
		while (wb < TOTAL_TRAFFIC) {
			if (signal.aborted) break

			for (let i = 0; i < BATCH_SIZE; i++) {
				writer.write(Buffer.alloc(MESSAGE_SIZE))
			}

			// oxlint-disable-next-line no-await-in-loop

			wb += MESSAGE_SIZE * BATCH_SIZE
		}

		let start = performance.now()
		await writer.flush()
		console.log(`Write took ${performance.now() - start} ms`)
		console.log(`Throughput: ${(wb / (performance.now() - start)) * 1000 / 1024 / 1024} MiB/s`)
	})()

	// Read messages from the topic
	void (async () => {
		let start = performance.now()

		for await (let batch of reader.read({ signal })) {
			let promise = reader.commit(batch)

			rb += MESSAGE_SIZE * batch.length

			if (rb === TOTAL_TRAFFIC) {
				await promise
				ctrl.abort()
			}
		}

		console.log(`Read took ${performance.now() - start} ms`)
		console.log(`Throughput: ${(rb / (performance.now() - start)) * 1000 / 1024 / 1024} MiB/s`)
	})()

	let start = Date.now()
	await once(ctrl.signal, 'abort')
	await writer.close()
	await reader.close()

	console.log(`Wrote ${wb} bytes and read ${rb} bytes in ${Date.now() - start} ms.`)
	console.log(`Throughput: ${(rb / (Date.now() - start)) * 1000 / 1024 / 1024} MiB/s`)
})
