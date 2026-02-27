// eslint-disable no-await-in-loop

/**
 * Integration tests for topic reader/writer stability across connection pool
 * refreshes (issue #557).
 *
 * The reproduction scenario: the driver periodically closes all pool channels
 * and replaces them with fresh ones after each discovery round.
 * Active bidirectional streams (reader / writer) receive a CANCELLED gRPC
 * status and must reconnect transparently.
 *
 * Before the fix:
 *   - CANCELLED was not treated as a retryable error for streams
 *   - writer became permanently destroyed after the first pool refresh
 *   - reader entered a zombie state and blocked read() forever
 */

import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { createTopicReader } from '../src/reader/index.js'
import { createTopicWriter } from '../src/writer/index.js'

// Shared admin driver (no discovery) for topic lifecycle — avoids connection
// disruptions from pool refreshes during setup/teardown.
let adminDriver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await adminDriver.ready()

let topicService = adminDriver.createClient(TopicServiceDefinition)

let testTopicName: string
let testConsumerName: string
let testDriver!: Driver

beforeEach(async () => {
	testTopicName = `test-topic-reconnect-${Date.now()}`
	testConsumerName = `test-consumer-reconnect-${Date.now()}`

	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: testTopicName,
			partitioningSettings: {
				minActivePartitions: 1n,
				maxActivePartitions: 1n,
			},
			consumers: [{ name: testConsumerName }],
		})
	)

	// Discovery enabled with a 10 s interval: every round closes old pool
	// channels and opens fresh ones, sending CANCELLED to active streams.
	testDriver = new Driver(inject('connectionString'), {
		'ydb.sdk.enable_discovery': true,
		'ydb.sdk.discovery_interval_ms': 10_000,
		'ydb.sdk.discovery_timeout_ms': 5_000,
	})
	await testDriver.ready()
})

afterEach(async () => {
	testDriver.close()

	await topicService.dropTopic(
		create(DropTopicRequestSchema, { path: testTopicName })
	)
})

test(
	'writer and reader survive repeated connection pool refreshes over 60 s',
	{ timeout: 90_000 },
	async () => {
		const TEST_DURATION_MS = 60_000
		const WRITE_INTERVAL_MS = 500 // one message every 500 ms → ~120 messages

		let writtenSeqNos = new Set<bigint>()
		let receivedSeqNos = new Set<bigint>()
		let readerAc = new AbortController()

		await using writer = createTopicWriter(testDriver, {
			topic: testTopicName,
		})

		await using reader = createTopicReader(testDriver, {
			topic: testTopicName,
			consumer: testConsumerName,
		})

		// ── Reader loop ────────────────────────────────────────────────────────
		let readerTask = (async () => {
			for await (let batch of reader.read({
				waitMs: 5_000,
				signal: readerAc.signal,
			})) {
				for (let msg of batch) {
					receivedSeqNos.add(msg.seqNo)
				}

				if (batch.length > 0) {
					await reader.commit(batch)
				}
			}
		})()

		// ── Writer loop ────────────────────────────────────────────────────────
		let deadline = Date.now() + TEST_DURATION_MS
		let index = 0

		while (Date.now() < deadline) {
			let seqNo = writer.write(new TextEncoder().encode(`msg-${index++}`))
			writtenSeqNos.add(seqNo)

			// flush() waits for the server ACK, so the seqNo is guaranteed to
			// be committed before we record it.
			await writer.flush()

			let remaining = deadline - Date.now()
			if (remaining > 0) {
				await new Promise((r) =>
					setTimeout(r, Math.min(WRITE_INTERVAL_MS, remaining))
				)
			}
		}

		// Give the reader up to 10 s to drain any in-flight messages.
		let drainDeadline = Date.now() + 10_000
		while (
			receivedSeqNos.size < writtenSeqNos.size &&
			Date.now() < drainDeadline
		) {
			await new Promise((r) => setTimeout(r, 200))
		}

		readerAc.abort()
		await readerTask.catch(() => {})

		// ── Assertions ─────────────────────────────────────────────────────────
		expect(writtenSeqNos.size).toBeGreaterThan(0)

		let missing = [...writtenSeqNos].filter(
			(seqNo) => !receivedSeqNos.has(seqNo)
		)
		expect(missing, `missing seqNos: ${missing.join(', ')}`).toHaveLength(0)
	}
)
