import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { afterAll, beforeAll, bench, inject } from 'vitest'

import { create } from '@bufbuild/protobuf'
import { Driver } from '@ydbjs/core'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { type TopicWriter, createTopicWriter } from '../src/writer/index.ts'

let TOTAL_TRAFFIC_BYTES = 128 * 1024 * 1024

let driver: Driver
let writer: TopicWriter
let testTopicName: string | undefined

beforeAll(async () => {
	driver = new Driver(inject('connectionString'), {
		'ydb.sdk.enable_discovery': false,
	})
	await driver.ready(AbortSignal.timeout(30_000))
})

afterAll(async () => {
	try {
		await teardown()
	} finally {
		driver?.close()
	}
})

async function setup() {
	// Tinybench does not await asynchronous teardown between warmup and measurement.
	await teardown()
	let topicName = `test-topic-bench-${Date.now()}`
	let consumerName = `test-consumer-${Date.now()}`

	let response = await driver.createClient(TopicServiceDefinition).createTopic(
		create(CreateTopicRequestSchema, {
			path: topicName,
			partitioningSettings: {
				minActivePartitions: 1n,
				maxActivePartitions: 100n,
			},
			consumers: [
				{
					name: consumerName,
				},
			],
		}),
		{ signal: AbortSignal.timeout(30_000) }
	)
	if (!response.operation?.ready || response.operation.status !== StatusIds_StatusCode.SUCCESS) {
		throw new Error(`Topic creation failed: ${response.operation?.status}`)
	}
	testTopicName = topicName

	writer = createTopicWriter(driver, {
		topic: topicName,
		maxBufferBytes: 1024n * 1024n * 1024n, // 1GB
	})
}

async function teardown() {
	writer?.destroy()
	if (testTopicName === undefined) return

	let response = await driver
		.createClient(TopicServiceDefinition)
		.dropTopic(create(DropTopicRequestSchema, { path: testTopicName }), {
			signal: AbortSignal.timeout(30_000),
		})
	if (!response.operation?.ready || response.operation.status !== StatusIds_StatusCode.SUCCESS) {
		throw new Error(`Topic deletion failed: ${response.operation?.status}`)
	}
	testTopicName = undefined
}

bench(
	'16KiB',
	async () => {
		let MESSAGE_SIZE = 16 * 1024
		let payload = new Uint8Array(MESSAGE_SIZE)

		for (let i = 0; i < TOTAL_TRAFFIC_BYTES / MESSAGE_SIZE; i++) {
			writer.write(payload)
		}

		await writer.flush(AbortSignal.timeout(60_000))
	},
	{ warmupIterations: 0, setup }
)

bench(
	'64KiB',
	async () => {
		let MESSAGE_SIZE = 64 * 1024
		let payload = new Uint8Array(MESSAGE_SIZE)

		for (let i = 0; i < TOTAL_TRAFFIC_BYTES / MESSAGE_SIZE; i++) {
			writer.write(payload)
		}

		await writer.flush(AbortSignal.timeout(60_000))
	},
	{ warmupIterations: 0, setup }
)

bench(
	'256KiB',
	async () => {
		let MESSAGE_SIZE = 256 * 1024
		let payload = new Uint8Array(MESSAGE_SIZE)

		for (let i = 0; i < TOTAL_TRAFFIC_BYTES / MESSAGE_SIZE; i++) {
			writer.write(payload)
		}

		await writer.flush(AbortSignal.timeout(60_000))
	},
	{ warmupIterations: 0, setup }
)

bench(
	'1MiB',
	async () => {
		let MESSAGE_SIZE = 1 * 1024 * 1024
		let payload = new Uint8Array(MESSAGE_SIZE)

		for (let i = 0; i < TOTAL_TRAFFIC_BYTES / MESSAGE_SIZE; i++) {
			writer.write(payload)
		}

		await writer.flush(AbortSignal.timeout(60_000))
	},
	{ warmupIterations: 0, setup }
)
