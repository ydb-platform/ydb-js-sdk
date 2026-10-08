import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { setTimeout as delay } from 'node:timers/promises'

import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { createTopicReader } from '../src/reader/index.js'
import { createTopicWriter } from '../src/writer/index.js'

let driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
await driver.ready()
let topicService = driver.createClient(TopicServiceDefinition)
let topic: string
let consumer: string

beforeEach(async () => {
	let suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
	topic = `reader-flow-control-${suffix}`
	consumer = `consumer-${suffix}`
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: topic,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 1n },
			consumers: [{ name: consumer }],
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: topic })).catch(() => {})
})

let waitForStableBuffer = async function waitForStableBuffer(
	reader: ReturnType<typeof createTopicReader>,
	signal: AbortSignal
): Promise<bigint> {
	let previous = -1n
	let stableSamples = 0
	while (!signal.aborted) {
		let current = reader.bufferedBytes
		if (current > 0n && current === previous) {
			stableSamples++
			if (stableSamples === 5) {
				return current
			}
		} else {
			stableSamples = 0
			previous = current
		}
		// oxlint-disable-next-line no-await-in-loop
		await delay(100, undefined, { signal })
	}
	throw signal.reason
}

test(
	'keeps a large server backlog inside the read-credit window when the consumer reads almost nothing',
	{ timeout: 60_000 },
	async (tc) => {
		let payload = new Uint8Array(2 * 1024).fill(42)
		await using writer = createTopicWriter(driver, { topic, producer: 'flow-control' })
		// Each acknowledged write batch stays below the read window. A single giant
		// write batch is indivisible on read and may legitimately overdraw the window.
		for (let batch = 0; batch < 128; batch++) {
			for (let message = 0; message < 16; message++) {
				writer.write(payload)
			}
			// oxlint-disable-next-line no-await-in-loop
			await writer.flush(tc.signal)
		}

		let maxBufferBytes = 64n * 1024n
		let changes: bigint[] = []
		let onBufferChanged = (message: unknown) => {
			let event = message as { consumer: string; bufferedBytes: bigint }
			if (event.consumer === consumer) {
				changes.push(event.bufferedBytes)
			}
		}
		subscribe('ydb:topic.reader.buffer.changed', onBufferChanged)
		try {
			await using reader = createTopicReader(driver, {
				topic,
				consumer,
				maxBufferBytes,
			})
			let initialBuffered = await waitForStableBuffer(reader, tc.signal)
			expect(initialBuffered).toBeLessThanOrEqual(2n * maxBufferBytes)

			let changesBeforeAborts = changes.length
			for (let i = 0; i < 3; i++) {
				let ac = new AbortController()
				let iterable = reader.read({ batchWindowMs: 60_000, signal: ac.signal })
				let iterator = iterable[Symbol.asyncIterator]()
				let next = iterator.next()
				// Give read() time to move every available response into its pending batch.
				// oxlint-disable-next-line no-await-in-loop
				await delay(200, undefined, { signal: tc.signal })
				ac.abort(new Error('cancel before yield'))
				// oxlint-disable-next-line no-await-in-loop
				await expect(next).rejects.toThrow('cancel before yield')
			}

			await delay(500, undefined, { signal: tc.signal })
			expect(changes).toHaveLength(changesBeforeAborts)
			expect(reader.bufferedBytes).toBe(initialBuffered)

			for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
				expect(batch).toHaveLength(1)
				break
			}
			await delay(500, undefined, { signal: tc.signal })
			expect(reader.bufferedBytes).toBeLessThanOrEqual(2n * maxBufferBytes)
			expect(changes.length).toBeGreaterThan(0)
			expect(
				changes.reduce((max, bytes) => (bytes > max ? bytes : max), 0n)
			).toBeLessThanOrEqual(2n * maxBufferBytes)
		} finally {
			unsubscribe('ydb:topic.reader.buffer.changed', onBufferChanged)
		}
	}
)

test('reports a server write batch that overdraws the initial read-credit window', async (tc) => {
	let payload = new Uint8Array(2 * 1024).fill(7)
	await using writer = createTopicWriter(driver, { topic, producer: 'oversized-read-batch' })
	for (let i = 0; i < 256; i++) {
		writer.write(payload)
	}
	await writer.flush(tc.signal)

	let maxBufferBytes = 64n * 1024n
	await using reader = createTopicReader(driver, { topic, consumer, maxBufferBytes })
	let buffered = await waitForStableBuffer(reader, tc.signal)
	expect(buffered).toBeGreaterThan(maxBufferBytes)

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch).toHaveLength(1)
		break
	}
	expect(reader.bufferedBytes).toBe(buffered)
})
