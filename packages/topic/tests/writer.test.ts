import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { GZIP_CODEC } from '../src/codec.ts'
import { createTopicReader } from '../src/reader/index.ts'
import { createTopicWriter } from '../src/writer/index.ts'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

let testTopicName: string
let testConsumerName: string
let testProducerName: string

beforeEach(async () => {
	testTopicName = `test-writer3-${Date.now()}`
	testConsumerName = `test-consumer-${Date.now()}`
	testProducerName = `test-producer-${Date.now()}`

	await driver.createClient(TopicServiceDefinition).createTopic(
		create(CreateTopicRequestSchema, {
			path: testTopicName,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 100n },
			consumers: [{ name: testConsumerName }],
		})
	)
})

afterEach(async () => {
	await driver
		.createClient(TopicServiceDefinition)
		.dropTopic(create(DropTopicRequestSchema, { path: testTopicName }))
})

let encode = function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

test('writes messages and reads them back in order', async () => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	writer.write(encode('Message 1'))
	writer.write(encode('Message 2'))
	writer.write(encode('Message 3'))

	let lastSeqNo = await writer.flush()
	expect(lastSeqNo).toBe(3n)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let contents: string[] = []
	let seqNos: bigint[] = []
	for await (let batch of reader.read({ limit: 10, batchWindowMs: 2000 })) {
		for (let message of batch) {
			contents.push(new TextDecoder().decode(message.payload))
			seqNos.push(message.seqNo)
		}
		await reader.commit(batch)
		if (contents.length >= 3) {
			break
		}
	}

	expect(contents).toEqual(['Message 1', 'Message 2', 'Message 3'])
	expect(seqNos).toEqual([1n, 2n, 3n])
})

test('assigns correct seqNos to messages written before initialization', async () => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	// Written before the stream is initialized — must be buffered, not dropped.
	writer.write(encode('Early 1'))
	writer.write(encode('Early 2'))

	let lastSeqNo = await writer.flush()
	expect(lastSeqNo).toBe(2n)

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let count = 0
	for await (let batch of reader.read({ limit: 10, batchWindowMs: 2000 })) {
		count += batch.length
		await reader.commit(batch)
		if (count >= 2) {
			break
		}
	}

	expect(count).toBe(2)
})

test(
	'continues the seqNo sequence for a new writer with the same producer',
	{ timeout: 15_000 },
	async () => {
		await using first = createTopicWriter(driver, {
			topic: testTopicName,
			producer: testProducerName,
		})
		first.write(encode('First 1'))
		first.write(encode('First 2'))
		expect(await first.flush()).toBe(2n)
		await first.close()

		await new Promise((resolve) => setTimeout(resolve, 500))

		await using second = createTopicWriter(driver, {
			topic: testTopicName,
			producer: testProducerName,
		})
		second.write(encode('Second 1'))
		// A fresh writer recovers the server high-water mark, so this continues at 3.
		expect(await second.flush()).toBe(3n)
	}
)

test('writes GZIP-compressed messages that read back decompressed', async () => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		codec: GZIP_CODEC,
	})

	let payload = 'compress-me-'.repeat(500)
	writer.write(encode(payload))
	await writer.flush()

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let received: string | null = null
	for await (let batch of reader.read({ limit: 1, batchWindowMs: 3000 })) {
		received = new TextDecoder().decode(batch[0]!.payload)
		await reader.commit(batch)
		break
	}

	// Written compressed, transparently decompressed by the reader.
	expect(received).toBe(payload)
})

test('accepts strictly increasing manual seqNos', async () => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	writer.write(encode('m10'), { seqNo: 10n })
	writer.write(encode('m20'), { seqNo: 20n })

	expect(await writer.flush()).toBe(20n)
})

test('flushes pending messages on graceful close', async () => {
	let writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	writer.write(encode('Buffered before close'))
	await writer.close()

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let found = false
	for await (let batch of reader.read({ limit: 1, batchWindowMs: 2000 })) {
		for (let message of batch) {
			if (new TextDecoder().decode(message.payload) === 'Buffered before close') {
				found = true
			}
		}
		await reader.commit(batch)
		if (found) {
			break
		}
	}

	expect(found).toBe(true)
})

test('invokes onAck for every acknowledged message', async () => {
	let acked: Array<[bigint, string]> = []
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		onAck: (seqNo, status) => acked.push([seqNo, status]),
	})

	writer.write(encode('a'))
	writer.write(encode('b'))
	writer.write(encode('c'))
	await writer.flush()

	acked.sort((a, b) => Number(a[0] - b[0]))
	expect(acked.map(([seqNo]) => seqNo)).toEqual([1n, 2n, 3n])
	expect(acked.every(([, status]) => status === 'written')).toBe(true)
})

test('deduplicates messages already written by the same producer', async () => {
	// First writer commits manual seqNos 1..3.
	await using first = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})
	first.write(encode('one'), { seqNo: 1n })
	first.write(encode('two'), { seqNo: 2n })
	first.write(encode('three'), { seqNo: 3n })
	await first.flush()
	await first.close()

	await new Promise((resolve) => setTimeout(resolve, 500))

	// A second writer re-sending the same seqNos must be deduplicated server-side
	// (acked as skipped), not written twice.
	let acked: Array<[bigint, string]> = []
	await using second = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
		onAck: (seqNo, status) => acked.push([seqNo, status]),
	})
	second.write(encode('one-again'), { seqNo: 1n })
	second.write(encode('two-again'), { seqNo: 2n })
	await second.flush()

	expect(acked.length).toBeGreaterThanOrEqual(2)
	expect(acked.every(([, status]) => status === 'skipped')).toBe(true)
})

test('writes many messages preserving order', async () => {
	await using writer = createTopicWriter(driver, {
		topic: testTopicName,
		producer: testProducerName,
	})

	let total = 50
	for (let i = 0; i < total; i++) {
		writer.write(encode(`msg-${i}`))
	}
	expect(await writer.flush()).toBe(BigInt(total))

	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let received: string[] = []
	for await (let batch of reader.read({ limit: total, batchWindowMs: 3000 })) {
		for (let message of batch) {
			received.push(new TextDecoder().decode(message.payload))
		}
		await reader.commit(batch)
		if (received.length >= total) {
			break
		}
	}

	expect(received).toHaveLength(total)
	expect(received).toEqual(Array.from({ length: total }, (_, i) => `msg-${i}`))
})
