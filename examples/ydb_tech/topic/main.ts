import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { create } from '@bufbuild/protobuf'
import { type Operation, StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	AlterTopicRequestSchema,
	Codec,
	CreateTopicRequestSchema,
	DescribeTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { topic } from '@ydbjs/topic'
import { GZIP_CODEC, RAW_CODEC, defaultCodecMap } from '@ydbjs/topic/codec'
import { type TopicReader, createTopicReader } from '@ydbjs/topic/reader'
import { createTopicWriter } from '@ydbjs/topic/writer'
import type { TopicMessage } from '@ydbjs/topic/message'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let topicName = `ydb_tech_${randomUUID().replaceAll('-', '')}`
let topicPath = topicName
let topicPath2 = `${topicName}_another`
let topicPath3 = `${topicName}_third`
let defaultProducerName = 'demo-producer'
let deadline = AbortSignal.timeout(90_000)
let createdTopics: string[] = []
let driver = new Driver(connectionString)
await driver.ready()
let topicFactory = topic(driver)
let customCodec = { codec: 10_000, compress: gzipSync, decompress: gunzipSync }
let lzopCodec = {
	codec: Codec.LZOP,
	compress: (payload: Uint8Array) => lzop(payload, false),
	decompress: (payload: Uint8Array) => lzop(payload, true),
}
defaultCodecMap.set(10_000, customCodec)
defaultCodecMap.set(Codec.LZOP, lzopCodec)
try {
	await createTopic()
	for (let path of [topicPath2, topicPath3]) {
		let service = driver.createClient(TopicServiceDefinition)
		let result = await service.createTopic(
			create(CreateTopicRequestSchema, {
				path,
				consumers: [{ name: 'selectors' }],
			})
		)
		checkOperation(result.operation)
		createdTopics.push(path)
	}
	let service = driver.createClient(TopicServiceDefinition)
	let result = await service.alterTopic(
		create(AlterTopicRequestSchema, {
			path: topicName,
			alterPartitioningSettings: { setMinActivePartitions: 4n },
			addConsumers: [
				'demo-consumer',
				'one',
				'batch',
				'commit_one',
				'commit_batch',
				'offset',
				'selector_partitions',
				'selector_lag',
				'selector_from',
				'selectors',
			].map((name) => ({ name })),
		})
	)
	checkOperation(result.operation)
	await initialize()
	await alterTopic()
	await describeTopic()
	await write()
	await writeMetadata()
	await writeAck(`${defaultProducerName}-ack`)
	await codecRaw()
	await codecGzip()
	await codecLzop()
	await codecCustom()
	for (let consumerName of ['one', 'batch', 'commit_one', 'commit_batch']) {
		await readScenario(consumerName)
	}
	await selectPartitions('selector_partitions')
	await selectLag('selector_lag')
	await selectFrom('selector_from')
	await selectMultiple('selectors')
	await offset('offset')
} finally {
	for (let path of createdTopics.reverse()) await dropTopic(path)
	driver.close()
}
console.log('All topic scenarios completed')

async function initialize() {
	// [BEGIN topic_init]
	let t = topic(driver)

	await using reader = t.createReader({
		topic: topicName,
		consumer: 'demo-consumer',
	})

	await using writer = t.createWriter({
		topic: topicName,
		producer: 'demo-producer',
	})
	// [END topic_init]
	void reader
	void writer
}

async function createTopic() {
	// [BEGIN topic_create]
	let topicService = driver.createClient(TopicServiceDefinition)
	let response = await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: topicName,
			partitioningSettings: {
				minActivePartitions: 1n,
				maxActivePartitions: 100n,
			},
			consumers: [{ name: 'my-consumer' }],
		})
	)
	// [END topic_create]
	checkOperation(response.operation)
	createdTopics.push(topicName)
}

async function alterTopic() {
	// [BEGIN topic_alter]
	let topicService = driver.createClient(TopicServiceDefinition)
	let response = await topicService.alterTopic(
		create(AlterTopicRequestSchema, {
			path: topicName,
			addConsumers: [{ name: 'my-consumer-2' }],
		})
	)
	// [END topic_alter]
	checkOperation(response.operation)
}

async function describeTopic() {
	// [BEGIN topic_describe]
	let topicService = driver.createClient(TopicServiceDefinition)
	let response = await topicService.describeTopic(
		create(DescribeTopicRequestSchema, {
			path: topicName,
		})
	)
	// [END topic_describe]
	checkOperation(response.operation)
}

async function dropTopic(path: string) {
	// [BEGIN topic_drop]
	let topicService = driver.createClient(TopicServiceDefinition)
	let response = await topicService.dropTopic(
		create(DropTopicRequestSchema, {
			path: path,
		})
	)
	// [END topic_drop]
	checkOperation(response.operation)
}

async function write() {
	let producerName = defaultProducerName
	// [BEGIN topic_start_writer]
	await using writer = createTopicWriter(driver, {
		topic: topicName,
		producer: producerName,
	})
	// [END topic_start_writer]
	// [BEGIN topic_write]
	// Writes a message to the internal buffer
	writer.write(Buffer.from('Hello, world!', 'utf-8'))

	// For immediate sending, you need to call flush
	await writer.flush()

	// Or close the writer
	await writer.close()
	// [END topic_write]
}

async function writeMetadata() {
	let producerName = defaultProducerName
	await using writer = createTopicWriter(driver, { topic: topicName, producer: producerName })
	// [BEGIN topic_write_metadata]
	writer.write(Buffer.from('Hello, world!', 'utf-8'), {
		metadataItems: {
			'meta-key': new TextEncoder().encode('meta-value'),
		},
	})
	// [END topic_write_metadata]
	await writer.flush()
}

async function writeAck(producerName: string) {
	// [BEGIN topic_write_ack]
	await using writer = createTopicWriter(driver, {
		topic: topicName,
		producer: producerName,
		// Callback that is called when writer receives an acknowledgment for a message.
		onAck: (seqNo, status) => {
			console.log('ACK', seqNo, status)
		},
	})

	writer.write(Buffer.from('Hello, world!', 'utf-8'))

	// To get the last written seqNo on the server.
	await writer.flush()
	// [END topic_write_ack]
}

async function codecRaw() {
	let producerName = defaultProducerName
	let t = topicFactory
	// [BEGIN topic_codec_raw]
	await using writer = t.createWriter({
		topic: topicName,
		producer: `${producerName}-raw`,
		codec: RAW_CODEC,
	})
	// [END topic_codec_raw]
	writer.write(Buffer.from('Hello, world!', 'utf-8'))
	await writer.flush()
}

async function codecGzip() {
	let producerName = defaultProducerName
	let t = topicFactory
	// [BEGIN topic_codec_gzip]
	await using writer = t.createWriter({
		topic: topicName,
		producer: `${producerName}-gzip`,
		codec: GZIP_CODEC,
	})
	// [END topic_codec_gzip]
	writer.write(Buffer.from('Hello, world!', 'utf-8'))
	await writer.flush()
}

async function codecLzop() {
	let producerName = defaultProducerName
	let t = topicFactory
	// [BEGIN topic_codec_lzop]
	await using writer = t.createWriter({
		topic: topicName,
		producer: `${producerName}-lzop`,
		codec: lzopCodec,
	})
	// [END topic_codec_lzop]
	writer.write(Buffer.from('Hello, world!', 'utf-8'))
	await writer.flush()
}

async function codecCustom() {
	let producerName = defaultProducerName
	let t = topicFactory
	// [BEGIN topic_codec_custom]
	await using writer = t.createWriter({
		topic: topicName,
		producer: `${producerName}-custom`,
		codec: customCodec,
	})
	// [END topic_codec_custom]
	writer.write(Buffer.from('Hello, world!', 'utf-8'))
	await writer.flush()
}

async function readScenario(consumerName: string) {
	console.log('Reading', consumerName)
	// [BEGIN topic_start_reader]
	await using reader = createTopicReader(driver, {
		topic: topicName,
		consumer: consumerName,
	})
	// [END topic_start_reader]
	bound(reader, 7)
	if (consumerName === 'one') {
		// [BEGIN topic_read_one]
		for await (let batch of reader.read()) {
			for await (let _msg of batch) {
			}
		}
		// [END topic_read_one]
	} else if (consumerName === 'batch') {
		// [BEGIN topic_read_batch]
		for await (let _batch of reader.read()) {
		}
		// [END topic_read_batch]
	} else if (consumerName === 'commit_one') {
		// [BEGIN topic_read_commit]
		for await (let batch of reader.read()) {
			for (let msg of batch) {
				await reader.commit(msg)
			}
		}
		// [END topic_read_commit]
	} else {
		// [BEGIN topic_read_batch_commit]
		for await (let batch of reader.read()) {
			await reader.commit(batch)
		}
		// [END topic_read_batch_commit]
	}
}

async function selectPartitions(consumerName: string) {
	console.log('Running selectPartitions')
	// [BEGIN topic_reader_selectors_partitions]
	await using reader = createTopicReader(driver, {
		topic: {
			path: topicPath,
			partitionIds: [1n, 2n, 3n],
		},
		consumer: consumerName,
	})
	// [END topic_reader_selectors_partitions]
	await seedSelection()
	await readAll(reader, 1)
}

async function selectLag(consumerName: string) {
	console.log('Running selectLag')
	// [BEGIN topic_reader_selectors_lag]
	await using reader = createTopicReader(driver, {
		topic: {
			path: topicPath,
			maxLag: '1s', // number, import('ms').StringValue, protobuff Duration
		},
		consumer: consumerName,
	})
	// [END topic_reader_selectors_lag]
	await seedSelection()
	await readAll(reader, 1)
}

async function selectFrom(consumerName: string) {
	console.log('Running selectFrom')
	// [BEGIN topic_reader_selectors_from]
	await using reader = createTopicReader(driver, {
		topic: {
			path: topicPath,
			readFrom: new Date(), // number, Date, protobuf Timestamp
		},
		consumer: consumerName,
	})
	// [END topic_reader_selectors_from]
	await seedSelection()
	await readAll(reader, 1)
}

async function selectMultiple(consumerName: string) {
	console.log('Running selectMultiple')
	// [BEGIN topic_reader_selectors_multiple]
	await using reader = createTopicReader(driver, {
		topic: [
			{
				path: topicPath,
				partitionIds: [1n, 2n, 3n],
			},
			{
				path: topicPath2,
				maxLag: '1s',
			},
			{
				path: topicPath3,
				readFrom: new Date(),
			},
			// ...
		],
		consumer: consumerName,
	})
	// [END topic_reader_selectors_multiple]
	await seedSelection()
	await readAll(reader, 1)
}

async function offset(consumerName: string) {
	console.log('Running offset')
	// [BEGIN topic_client_offset]
	await using reader = createTopicReader(driver, {
		topic: topicName,
		consumer: consumerName,
		onPartitionSessionStart: async (_evt) => {
			return {
				readOffset: 0n,
				commitOffset: 0n,
			}
		},
	})
	// [END topic_client_offset]
	await readAll(reader, 7)
}

async function seedSelection() {
	await using writer = createTopicWriter(driver, {
		topic: topicPath,
		producer: randomUUID(),
		partitionId: 1n,
	})
	writer.write(Buffer.from('Hello, world!', 'utf-8'))
	await writer.flush()
}

function lzop(payload: Uint8Array, decompress: boolean): Uint8Array {
	let result = spawnSync('lzop', decompress ? ['-d', '-c'] : ['-c'], { input: payload })
	if (result.error) throw result.error
	assert.equal(result.status, 0, result.stderr.toString())
	return result.stdout
}

function checkOperation(operation: Operation | undefined): asserts operation is Operation {
	assert(operation?.ready, 'The topic operation has not completed')
	assert.equal(operation.status, StatusIds_StatusCode.SUCCESS, JSON.stringify(operation.issues))
}

function checkMessage(message: TopicMessage): void {
	assert.equal(Buffer.from(message.payload).toString(), 'Hello, world!')
	if (message.metadataItems?.['meta-key']) {
		assert.equal(Buffer.from(message.metadataItems['meta-key']).toString(), 'meta-value')
	}
}

function bound(reader: TopicReader, count: number): void {
	let read = reader.read.bind(reader)
	reader.read = async function* () {
		let received = 0
		for await (let batch of read({ signal: deadline, limit: count })) {
			for (let message of batch) checkMessage(message)
			received += batch.length
			console.log('Received', received, 'of', count)
			yield batch
			if (received === count) break
		}
		assert.equal(received, count)
	}
}

async function readAll(reader: TopicReader, count: number): Promise<void> {
	bound(reader, count)
	for await (let batch of reader.read()) {
		assert(batch.length > 0)
	}
}
