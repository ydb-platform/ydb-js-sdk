import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import type { TopicMessage } from '@ydbjs/topic/message'
import { createTopicReader, createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter, createTopicWriter } from '@ydbjs/topic/writer'

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
		}),
		{ signal: AbortSignal.timeout(1000) }
	)
})

afterEach(async () => {
	await topicService.dropTopic(
		create(DropTopicRequestSchema, {
			path: testTopicName,
		}),
		{ signal: AbortSignal.timeout(1000) }
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
	let batchInsideTx: TopicMessage[] | undefined
	await yql.begin({ idempotent: true }, async (tx) => {
		let readerTx = createTopicTxReader(tx, driver, {
			topic: testTopicName,
			consumer: testConsumerName,
		})

		let writerTx = createTopicTxWriter(tx, driver, {
			topic: testTopicName,
			producer: testProducerName,
		})

		// Write a message inside the transaction (2)
		writerTx.write(Buffer.from('written in tx', 'utf-8'), { seqNo: 2n })
		await writerTx.flush()

		// Read messages inside the transaction.
		// Expect to see the message written outside the transaction (1).
		// Expect NOT to see the message written in the transaction (2).
		for await (let batch of readerTx.read({
			signal: AbortSignal.timeout(5000),
		})) {
			batchInsideTx = batch
			break
		}
	})

	expect(batchInsideTx).toStrictEqual([
		expect.objectContaining({
			seqNo: 1n,
			offset: 0n,
			payload: Buffer.from('written', 'utf-8'),
		}),
	])

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	// Read messages outside of the transaction.
	// Expect to see the message written in the transaction (2).
	// Expect NOT to see the message written outside the transaction (1).
	let batchOutsideTx: TopicMessage[] | undefined
	for await (let batch of reader.read({
		signal: AbortSignal.timeout(5000),
	})) {
		batchOutsideTx = batch
		await reader.commit(batch)
		break
	}

	expect(batchOutsideTx).toStrictEqual([
		expect.objectContaining({
			seqNo: 2n,
			offset: 1n,
			payload: Buffer.from('written in tx', 'utf-8'),
		}),
	])
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

	await expect(async () => {
		await yql.begin({ idempotent: true }, async (tx) => {
			let readerTx = createTopicTxReader(tx, driver, {
				topic: testTopicName,
				consumer: testConsumerName,
			})

			for await (let _ of readerTx.read()) {
				break
			}

			// Simulate a transaction failure. User error is always non-retriable.
			throw new Error('User error')
		})
	}).rejects.toMatchObject({
		message: 'Transaction failed.',
		cause: expect.objectContaining({ message: 'User error' }),
	})

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	// Read messages outside of the transaction.
	// Expect to see the message written outside the transaction (1).
	let committedBatch: Array<TopicMessage> | undefined
	for await (let batch of reader.read()) {
		committedBatch = batch
		await reader.commit(batch)
		break
	}

	expect(committedBatch).toStrictEqual([
		expect.objectContaining({
			seqNo: 1n,
			offset: 0n,
			payload: Buffer.from('written', 'utf-8'),
		}),
	])
})

test('rollbacks writes', async () => {
	await using yql = query(driver)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	await expect(async () => {
		await yql.begin({ idempotent: true }, async (tx) => {
			let writerTx = createTopicTxWriter(tx, driver, {
				topic: testTopicName,
				producer: testProducerName,
			})

			// Write a message inside the transaction (2)
			writerTx.write(Buffer.from('written in tx', 'utf-8'), { seqNo: 2n })
			await writerTx.flush()

			// Simulate a transaction failure. User error is always non-retriable.
			throw new Error('User error')
		})
	}).rejects.toMatchObject({
		message: 'Transaction failed.',
		cause: expect.objectContaining({ message: 'User error' }),
	})

	// Read messages outside of the transaction.
	// Expect NOT to see the message written inside the transaction (2).
	let observedBatch: Array<TopicMessage> | undefined
	for await (let batch of reader.read({ waitMs: 1000 })) {
		observedBatch = batch
		break
	}

	expect(observedBatch).toStrictEqual([])
})
