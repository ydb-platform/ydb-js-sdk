import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode, type Operation } from '@ydbjs/api/operation'
import {
	AlterTopicRequestSchema,
	Codec,
	CreateTopicRequestSchema,
	DescribeTopicRequestSchema,
	DescribeTopicResultSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { topic } from '@ydbjs/topic'
import { defaultCodecMap, GZIP_CODEC, RAW_CODEC } from '@ydbjs/topic/codec'
import { createTopicReader, type TopicReader } from '@ydbjs/topic/reader'
import { createTopicWriter } from '@ydbjs/topic/writer'
import type { TopicMessage } from '@ydbjs/topic/message'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let topicName = `ydb_tech_${randomUUID().replaceAll('-', '')}`
let topicName2 = `${topicName}_another`
let topicName3 = `${topicName}_third`
let producerName = 'ydb-tech-producer'
let consumers = ['one', 'batch', 'commit_one', 'commit_batch', 'selectors', 'offset']
let expected = new Set(['buffered', 'acknowledged', 'metadata', 'codec-raw', 'codec-gzip', 'codec-custom'])
let deadline = AbortSignal.timeout(60_000)
let createdTopics: string[] = []

// [BEGIN topic_init]
let driver = new Driver(connectionString)
await driver.ready()
let t = topic(driver)
// [END topic_init]

try {
	// [BEGIN topic_create]
	let topicService = driver.createClient(TopicServiceDefinition)
	let createResponse = await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: topicName,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 100n },
			supportedCodecs: { codecs: [Codec.RAW, Codec.GZIP, 10_000] },
			consumers: consumers.map((name) => ({ name })),
		})
	)
	checkOperation(createResponse.operation)
	// [END topic_create]
	createdTopics.push(topicName)
	for (let path of [topicName2, topicName3]) {
		let response = await topicService.createTopic(create(CreateTopicRequestSchema, {
			path, consumers: [{ name: 'selectors' }],
		}))
		checkOperation(response.operation)
		createdTopics.push(path)
	}

	// [BEGIN topic_alter]
	let alterResponse = await topicService.alterTopic(create(AlterTopicRequestSchema, {
		path: topicName,
		addConsumers: [{ name: 'another-consumer' }],
	}))
	checkOperation(alterResponse.operation)
	// [END topic_alter]

	// [BEGIN topic_describe]
	let describeResponse = await topicService.describeTopic(create(DescribeTopicRequestSchema, {
		path: topicName,
	}))
	checkOperation(describeResponse.operation)
	let description = anyUnpack(describeResponse.operation!.result!, DescribeTopicResultSchema)
	// [END topic_describe]
	assert(description?.consumers.some((consumer) => consumer.name === 'another-consumer'))

	// [BEGIN topic_start_writer]
	await using writer = createTopicWriter(driver, {
		topic: topicName,
		producer: producerName,
	})
	// [END topic_start_writer]
	// [BEGIN topic_write]
	writer.write(Buffer.from('buffered'))
	await writer.flush()
	// [END topic_write]
	// [BEGIN topic_write_metadata]
	writer.write(Buffer.from('metadata'), {
		metadataItems: { 'meta-key': new TextEncoder().encode('meta-value') },
	})
	await writer.flush()
	// [END topic_write_metadata]
	await writer.close()

	// [BEGIN topic_write_ack]
	let acknowledged = false
	await using ackWriter = createTopicWriter(driver, {
		topic: topicName,
		producer: `${producerName}-ack`,
		onAck: (_seqNo, status) => { acknowledged = status === 'written' },
	})
	ackWriter.write(Buffer.from('acknowledged'))
	await ackWriter.flush()
	// [END topic_write_ack]
	assert(acknowledged)
	await ackWriter.close()

	// [BEGIN topic_codec]
	for (let [codec, payload] of [[RAW_CODEC, 'codec-raw'], [GZIP_CODEC, 'codec-gzip']] as const) {
		await using codecWriter = t.createWriter({
			topic: topicName, producer: `${producerName}-${payload}`, codec,
		})
		codecWriter.write(Buffer.from(payload))
		await codecWriter.flush()
	}
	let customCodec = { codec: 10_000, compress: gzipSync, decompress: gunzipSync }
	await using customWriter = t.createWriter({
		topic: topicName, producer: `${producerName}-custom`, codec: customCodec,
	})
	customWriter.write(Buffer.from('codec-custom'))
	await customWriter.flush()
	// [END topic_codec]
	await customWriter.close()
	let codecMap = new Map(defaultCodecMap)
	codecMap.set(10_000, customCodec)

	for (let consumerName of ['one', 'batch', 'commit_one', 'commit_batch']) {
		// [BEGIN topic_start_reader]
		await using reader = createTopicReader(driver, {
			topic: topicName, consumer: consumerName, codecMap,
		})
		// [END topic_start_reader]
		let received = new Set<string>()
		if (consumerName === 'one') {
			// [BEGIN topic_read_one]
			for await (let batch of reader.read({ signal: deadline, limit: expected.size })) {
				for (let message of batch) {
					received.add(checkMessage(message))
				}
				if (received.size === expected.size) break
			}
			// [END topic_read_one]
		} else if (consumerName === 'batch') {
			// [BEGIN topic_read_batch]
			for await (let batch of reader.read({ signal: deadline, limit: expected.size })) {
				processBatch(batch, received)
				if (received.size === expected.size) break
			}
			// [END topic_read_batch]
		} else if (consumerName === 'commit_one') {
			// [BEGIN topic_read_commit]
			for await (let batch of reader.read({ signal: deadline, limit: expected.size })) {
				for (let message of batch) {
					received.add(checkMessage(message))
					await reader.commit(message)
				}
				if (received.size === expected.size) break
			}
			// [END topic_read_commit]
		} else {
			// [BEGIN topic_read_batch_commit]
			for await (let batch of reader.read({ signal: deadline, limit: expected.size })) {
				processBatch(batch, received)
				await reader.commit(batch)
				if (received.size === expected.size) break
			}
			// [END topic_read_batch_commit]
		}
		assert.deepEqual(received, expected)
	}

	// [BEGIN topic_reader_selectors]
	await using selectorReader = createTopicReader(driver, {
		topic: [
			{ path: topicName, partitionIds: [0n] },
			{ path: topicName2, maxLag: '1h' },
			{ path: topicName3, readFrom: new Date(0) },
		],
		consumer: 'selectors', codecMap,
	})
	// [END topic_reader_selectors]
	await readAll(selectorReader)

	// [BEGIN topic_client_offset]
	let offsets = new Map<bigint, bigint>()
	await using offsetReader = createTopicReader(driver, {
		topic: topicName, consumer: 'offset', codecMap,
		onPartitionSessionStart: async (session) => ({
			readOffset: offsets.get(session.partitionId) ?? 0n,
			commitOffset: offsets.get(session.partitionId) ?? 0n,
		}),
	})
	// [END topic_client_offset]
	await readAll(offsetReader)
} finally {
	for (let path of createdTopics.reverse()) {
		// [BEGIN topic_drop]
		let topicService = driver.createClient(TopicServiceDefinition)
		let response = await topicService.dropTopic(create(DropTopicRequestSchema, { path }))
		checkOperation(response.operation)
		// [END topic_drop]
	}
	driver.close()
}
console.log('All topic scenarios completed')

function checkOperation(operation: Operation | undefined): asserts operation is Operation {
	assert(operation?.ready, 'The topic operation has not completed')
	assert.equal(operation.status, StatusIds_StatusCode.SUCCESS, JSON.stringify(operation.issues))
}

function checkMessage(message: TopicMessage): string {
	let payload = Buffer.from(message.payload).toString()
	assert(expected.has(payload), `Unexpected payload: ${payload}`)
	if (payload === 'metadata') {
		assert(message.metadataItems?.['meta-key'])
		assert.equal(Buffer.from(message.metadataItems['meta-key']).toString(), 'meta-value')
	}
	return payload
}

function processBatch(batch: TopicMessage[], received: Set<string>): void {
	for (let message of batch) received.add(checkMessage(message))
}

async function readAll(reader: TopicReader): Promise<void> {
	let received = new Set<string>()
	for await (let batch of reader.read({ signal: deadline, limit: expected.size })) {
		processBatch(batch, received)
		if (received.size === expected.size) break
	}
	assert.deepEqual(received, expected)
}
