import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'

import { createTopicReader } from '../src/reader/index.js'
import { createTopicWriter } from '../src/writer/index.js'

// Real-YDB coverage for topic schema-lifecycle interaction: how the reader / writer
// behave when the topic does not exist yet (the server answers SCHEME_ERROR — not
// NOT_FOUND), and the `retryOnSchemeError` opt-in that waits for the topic to be
// created. The FSM mechanism is covered by the unit / contract tests; these lock in the
// live server behaviour the design relies on. Schema-change scenarios belong in the int
// tier (this file) next to reader-protocol.test.ts, not e2e (which is cross-feature).

let driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
await driver.ready()
let topicService = driver.createClient(TopicServiceDefinition)

let topic: string
let consumer: string

beforeEach(() => {
	topic = `topic-lifecycle-${Date.now()}`
	consumer = `consumer-${Date.now()}`
})

afterEach(async () => {
	// A test may or may not have created the topic; drop it if present.
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: topic })).catch(() => {})
})

let makeTopic = async function makeTopic(): Promise<void> {
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: topic,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 1n },
			consumers: [{ name: consumer }],
		})
	)
}

let writeTwo = async function writeTwo(a: number, b: number): Promise<void> {
	await using writer = createTopicWriter(driver, { topic, producer: `p-${a}` })
	writer.write(new Uint8Array([a]))
	writer.write(new Uint8Array([b]))
	await writer.flush()
}

let waitUntil = async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
	let started = Date.now()
	while (Date.now() - started < ms) {
		if (predicate()) return true
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	return predicate()
}

test('surfaces SCHEME_ERROR to a reader when the topic is missing', async (tc) => {
	// Sync `using` (destroy) — a terminally-errored reader rethrows from async close().
	using reader = createTopicReader(driver, { topic, consumer })
	let caught: unknown
	try {
		// No batchWindowMs: block for one chunk. The missing topic terminates the reader, which
		// closes the chunk queue → read() throws the terminal error (not an empty tick).
		for await (let batch of reader.read({ signal: tc.signal })) {
			void batch
		}
	} catch (error) {
		caught = error
	}
	expect(caught).toBeInstanceOf(YDBError)
	expect((caught as YDBError).code).toBe(StatusIds_StatusCode.SCHEME_ERROR)
})

test('rejects a writer flush with SCHEME_ERROR when the topic is missing', async () => {
	// Not `await using`: after a terminal error close() rethrows it — destroy() is the
	// non-throwing teardown for the failed-writer case.
	let writer = createTopicWriter(driver, { topic, producer: 'p' })
	writer.write(new Uint8Array([1]))
	await expect(writer.flush()).rejects.toMatchObject({ code: StatusIds_StatusCode.SCHEME_ERROR })
	writer.destroy()
})

test('waits for the topic to be created before reading with retryOnSchemeError', async (tc) => {
	await using reader = createTopicReader(driver, { topic, consumer, retryOnSchemeError: true })

	let received: number[] = []
	void (async () => {
		try {
			for await (let batch of reader.read({ batchWindowMs: 200, signal: tc.signal })) {
				for (let message of batch) received.push(message.payload[0]!)
			}
		} catch {
			// reader closed / signal aborted at teardown
		}
	})()

	// The reader is now retrying SCHEME_ERROR. Create the topic and write to it.
	await new Promise((resolve) => setTimeout(resolve, 1000))
	await makeTopic()
	await writeTwo(10, 20)

	let healed = await waitUntil(() => received.includes(10) && received.includes(20), 20_000)
	expect(healed).toBe(true)
})

test('waits for the topic to be created before writing with retryOnSchemeError', async () => {
	await using writer = createTopicWriter(driver, {
		topic,
		producer: 'p',
		retryOnSchemeError: true,
	})
	writer.write(new Uint8Array([42]))
	// The topic does not exist yet: the flush stays pending while the writer retries
	// SCHEME_ERROR instead of failing.
	let flushed = writer.flush()

	await new Promise((resolve) => setTimeout(resolve, 1000))
	await makeTopic()

	// Once the topic exists the write is acknowledged and the flush resolves.
	let seqNo = await flushed
	expect(seqNo).toBeGreaterThanOrEqual(1n)
})
