import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import type { TopicMessage } from '../src/message.ts'
import { createTopicReader, createTopicTxReader } from '../src/reader/index.ts'
import type { TopicTxReader } from '../src/reader/index.ts'
import { createTopicTxWriter, createTopicWriter } from '../src/writer/index.ts'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

let testTopicName: string
let testConsumerName: string
let testProducerName: string

beforeEach(async () => {
	testTopicName = `test-tx-parity-${Date.now()}`
	testConsumerName = `test-consumer-${Date.now()}`
	testProducerName = `test-producer-${Date.now()}`

	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: testTopicName,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 100n },
			consumers: [{ name: testConsumerName }],
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: testTopicName }))
})

let encode = function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

let decode = function decode(payload: Uint8Array): string {
	return new TextDecoder().decode(payload)
}

// Accumulate exactly `count` messages, waiting as long as it takes (bounded by the
// test timeout via the signal).
let readMessages = async function readMessages(
	reader: Pick<TopicTxReader, 'read'>,
	count: number,
	signal: AbortSignal
): Promise<TopicMessage[]> {
	let collected: TopicMessage[] = []
	for await (let batch of reader.read({ limit: count, batchWindowMs: 1000, signal })) {
		collected.push(...batch)
		if (collected.length >= count) {
			break
		}
	}
	return collected
}

// Collect whatever arrives within a fixed number of batch windows — used to assert
// on the full visible contents of a topic (including "nothing is visible").
let collectDuringWindows = async function collectDuringWindows(
	reader: Pick<TopicTxReader, 'read'>,
	windows: number,
	signal: AbortSignal
): Promise<TopicMessage[]> {
	let collected: TopicMessage[] = []
	let seen = 0
	for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000, signal })) {
		collected.push(...batch)
		seen += 1
		if (seen >= windows) {
			break
		}
	}
	return collected
}

test('commits tx-read offsets with the transaction commit', { timeout: 30_000 }, async (tc) => {
	await using yql = query(driver)

	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})
	writer.write(encode('pre-1'))
	writer.write(encode('pre-2'))
	writer.write(encode('pre-3'))
	await writer.close(tc.signal)

	// Consume all three messages inside a transaction; the offsets must be bound to
	// the tx (UpdateOffsetsInTransaction) before the transaction commits.
	await yql.begin({ idempotent: true }, async (tx) => {
		let readerTx = createTopicTxReader(tx, driver, {
			topic: testTopicName,
			consumer: testConsumerName,
		})
		let consumed = await readMessages(readerTx, 3, tc.signal)
		expect(consumed.map((message) => decode(message.payload))).toEqual([
			'pre-1',
			'pre-2',
			'pre-3',
		])
	})

	await using postWriter = createTopicWriter(driver, {
		topic: testTopicName,
		producer: `${testProducerName}-post`,
	})
	postWriter.write(encode('after-commit'))
	await postWriter.close(tc.signal)

	// The consumer's committed offset moved with the tx: a fresh reader must start
	// past the tx-consumed messages and see only the post-commit one.
	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})
	let delivered = await readMessages(reader, 1, tc.signal)
	expect(delivered.map((message) => [decode(message.payload), message.offset])).toEqual([
		['after-commit', 3n],
	])
})

test('redelivers messages read in a rolled-back transaction', { timeout: 30_000 }, async (tc) => {
	await using yql = query(driver)

	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})
	writer.write(encode('pre-1'))
	writer.write(encode('pre-2'))
	await writer.close(tc.signal)

	await expect(
		yql.begin({ idempotent: true }, async (tx) => {
			let readerTx = createTopicTxReader(tx, driver, {
				topic: testTopicName,
				consumer: testConsumerName,
			})
			let consumed = await readMessages(readerTx, 2, tc.signal)
			expect(consumed).toHaveLength(2)

			// User error is always non-retriable — the transaction rolls back.
			throw new Error('User error')
		})
	).rejects.toMatchObject({
		message: 'Transaction failed.',
		cause: expect.objectContaining({ message: 'User error' }),
	})

	// Nothing was committed: a fresh reader sees the same messages from offset 0.
	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})
	let redelivered = await readMessages(reader, 2, tc.signal)
	expect(redelivered.map((message) => [decode(message.payload), message.offset])).toEqual([
		['pre-1', 0n],
		['pre-2', 1n],
	])
})

test('discards messages written in a rolled-back transaction', { timeout: 30_000 }, async (tc) => {
	await using yql = query(driver)

	await expect(
		yql.begin({ idempotent: true }, async (tx) => {
			let writerTx = createTopicTxWriter(tx, driver, {
				topic: testTopicName,
				producer: testProducerName,
			})
			writerTx.write(encode('written-in-tx'))
			// Flush so the message reaches the server tagged with the tx before the failure.
			await writerTx.flush(tc.signal)

			// User error is always non-retriable — the transaction rolls back.
			throw new Error('User error')
		})
	).rejects.toMatchObject({
		message: 'Transaction failed.',
		cause: expect.objectContaining({ message: 'User error' }),
	})

	// A committed sentinel makes the check deterministic: once it is delivered, the
	// rolled-back message would already have been delivered too if it were visible.
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: `${testProducerName}-sentinel`,
	})
	writer.write(encode('sentinel'))
	await writer.close(tc.signal)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})
	let observed = await readMessages(reader, 1, tc.signal)
	expect(observed.map((message) => decode(message.payload))).toEqual(['sentinel'])
})

test('publishes tx writes only after the transaction commits', { timeout: 45_000 }, async (tc) => {
	await using yql = query(driver)

	let acks: Array<[bigint, string]> = []

	await yql.begin({ idempotent: true }, async (tx) => {
		let writerTx = createTopicTxWriter(tx, driver, {
			topic: testTopicName,
			producer: testProducerName,
			onAck: (seqNo, status) => acks.push([seqNo, status]),
		})

		writerTx.write(encode('tx-1'))
		writerTx.write(encode('tx-2'))
		await writerTx.flush(tc.signal)

		// Flushed but uncommitted: a parallel reader must not see the messages.
		{
			await using probe = createTopicReader(driver, {
				topic: testTopicName,
				consumer: testConsumerName,
			})
			let observed = await collectDuringWindows(probe, 3, tc.signal)
			expect(observed).toEqual([])
		}

		// Left unflushed on purpose: the tx commit must drain the writer before the
		// transaction is committed, so fire-and-forget tx writes are never lost.
		writerTx.write(encode('tx-3'))
	})

	acks.sort((a, b) => Number(a[0] - b[0]))
	expect(acks).toEqual([
		[1n, 'writtenInTx'],
		[2n, 'writtenInTx'],
		[3n, 'writtenInTx'],
	])

	// After commit every tx write — including the unflushed one — is visible.
	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})
	let delivered = await readMessages(reader, 3, tc.signal)
	expect(delivered.map((message) => decode(message.payload))).toEqual(['tx-1', 'tx-2', 'tx-3'])
})
