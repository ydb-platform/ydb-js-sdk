import { afterEach, beforeEach, expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { createTopicReader, createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter, createTopicWriter } from '@ydbjs/topic/writer'
import { CreateTopicRequestSchema, DropTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'
import { create } from '@bufbuild/protobuf'
import { query } from '@ydbjs/query'

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

test('writes and reads in tx', async () => {
	await using yql = query(driver)

	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	// Write a message outside of a transaction (1)
	writer.write(Buffer.from('written', 'utf-8'), { seqNo: 1n })
	await writer.close()

	// Begin a transaction
	await yql.begin({ idempotent: true }, async (tx) => {
		let readerTx = createTopicTxReader(driver, {
			tx,
			topic: testTopicName,
			consumer: testConsumerName,
		})

		await using writerTx = createTopicTxWriter(tx, driver, {
			topic: testTopicName,
			producer: testProducerName,
		})

		// Write a message inside the transaction (2)
		writerTx.write(Buffer.from('written in tx', 'utf-8'), { seqNo: 2n })
		await writerTx.flush()

		// Read messages inside the transaction.
		// Expect to see the message written outside the transaction (1).
		// Expect NOT to see the message written in the transaction (2).
		for await (let batch of readerTx.read()) {
			expect(batch).toHaveLength(1)

			let message = batch[0]!
			expect(message.seqNo).toBe(1n)
			expect(message.offset).toBe(0n)
			expect(message.payload).toStrictEqual(Buffer.from('written', 'utf-8'))
			break
		}
	})

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	// Read messages outside of the transaction.
	// Expect to see the message written in the transaction (2).
	// Expect NOT to see the message written outside the transaction (1).
	for await (let batch of reader.read()) {
		expect(batch).toHaveLength(1)

		let message = batch[0]!
		expect(message.seqNo).toBe(2n)
		expect(message.offset).toBe(1n)
		expect(message.payload).toStrictEqual(Buffer.from('written in tx', 'utf-8'))
		await reader.commit(batch)
		break
	}
})

test('rollbacks reads', async () => {
	await using yql = query(driver)

	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	// Write a message outside of a transaction (1)
	writer.write(Buffer.from('written', 'utf-8'), { seqNo: 1n })
	await writer.close()

	await yql
		.begin({ idempotent: true }, async (tx) => {
			let readerTx = createTopicTxReader(driver, {
				tx,
				topic: testTopicName,
				consumer: testConsumerName,
			})


			// Read messages inside the transaction.
			// Expect to see the message written outside the transaction (1).
			for await (let batch of readerTx.read()) {
				expect(batch).toHaveLength(1)
				expect(batch[0]?.payload).toStrictEqual(Buffer.from('written', 'utf-8'))
				break
			}

			// Simulate a transaction failure. User error is always non-retriable.
			throw new Error('User error')
		})
		.catch((error) => {
			expect(error).toBeInstanceOf(Error)
			expect(error.message).toBe('Transaction failed.')
			expect((error as Error).cause).toBeInstanceOf(Error)
			expect(((error as Error).cause as Error).message).toBe('User error')
		})

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	// Read messages outside of the transaction.
	// Expect to see the message written outside the transaction (1).
	for await (let batch of reader.read()) {
		expect(batch).toHaveLength(1)

		let message = batch[0]!
		expect(message.seqNo).toBe(1n)
		expect(message.offset).toBe(0n)
		expect(message.payload).toStrictEqual(Buffer.from('written', 'utf-8'))
		await reader.commit(batch)
		break
	}
})

test('rollbacks writes', async () => {
	await using yql = query(driver)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	await yql
		.begin({ idempotent: true }, async (tx) => {
			await using writerTx = createTopicTxWriter(tx, driver, {
				topic: testTopicName,
				producer: testProducerName,
			})

			// Write a message inside the transaction (2)
			writerTx.write(Buffer.from('written in tx', 'utf-8'), { seqNo: 2n })
			await writerTx.flush()

			// Simulate a transaction failure. User error is always non-retriable.
			throw new Error('User error')
		})
		.catch((error) => {
			expect(error).toBeInstanceOf(Error)
			expect(error.message).toBe('Transaction failed.')
			expect((error as Error).cause).toBeInstanceOf(Error)
			expect(((error as Error).cause as Error).message).toBe('User error')
		})

	// Read messages outside of the transaction.
	// Expect NOT to see the message written inside the transaction (2).
	for await (let batch of reader.read({ waitMs: 1000 })) {
		expect(batch).toHaveLength(0)
		break
	}
})
