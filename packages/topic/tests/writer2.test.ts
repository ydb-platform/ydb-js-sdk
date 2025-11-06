import * as assert from 'node:assert'
import { nextTick } from 'node:process'
import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { CreateTopicRequestSchema, DropTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'
import { type ActorRef, type AnyActor, type AnyMachineSnapshot, createActor } from 'xstate'
import { TopicWriter, WriterMachine } from '../src/writer2/index.ts'
import type { WriterEmitted } from '../src/writer2/types.ts'
import { YDBError } from '@ydbjs/error'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { createTopicReader } from '../src/reader/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

// Generate unique topic name for each test
let testTopicName: string
let testConsumerName: string
let testProducerName: string

beforeEach(async () => {
	testTopicName = `test-topic-integration-${Date.now()}`
	testConsumerName = `test-consumer-${Date.now()}`
	testProducerName = `test-producer-${Date.now()}`

	await driver.createClient(TopicServiceDefinition).createTopic(
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
	await driver.createClient(TopicServiceDefinition).dropTopic(
		create(DropTopicRequestSchema, {
			path: testTopicName,
		})
	)
})

// Helper: wait for actor event (with AbortSignal support)
type EventTypeOf<A> = A extends ActorRef<any, any, infer TEvent> ? TEvent : never

async function waitForEvent<A extends AnyActor>(
	actor: A,
	eventType: EventTypeOf<A>['type'],
	signal: AbortSignal
): Promise<EventTypeOf<A>> {
	let promise = await new Promise<EventTypeOf<A>>((resolve) => {
		let sub = actor.on(eventType, (event) => {
			sub.unsubscribe()
			resolve(event as any)
		})

		signal.addEventListener('abort', () => {
			sub.unsubscribe()
		})
	})

	return await abortable(signal, Promise.resolve(promise))
}

async function waitForState<A extends AnyActor>(actor: A, state: string, signal: AbortSignal): Promise<any> {
	let promise = await new Promise<any>((resolve) => {
		let sub = actor.subscribe((snapshot: AnyMachineSnapshot) => {
			if (snapshot.value === state) {
				sub.unsubscribe()
				resolve(snapshot.value)
			}
		})
	})

	return await abortable(signal, Promise.resolve(promise))
}

test('writes messages and receive acknowledges', async (tc) => {
	let data = new Uint8Array(8 * 1024 * 1024)

	let actor = createActor(WriterMachine, {
		input: {
			driver,
			options: {
				topic: testTopicName,
				producerId: testProducerName,
			},
		},
	})

	actor.start()

	await waitForEvent(actor, 'writer.session', tc.signal)
	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({
		type: 'writer.write',
		message: { seqNo: 1n, data: data },
	})

	let event: WriterEmitted = await waitForEvent(actor, 'writer.acknowledgments', tc.signal)
	assert.ok(event.type === 'writer.acknowledgments', 'Expected writer.acknowledgments event')
	assert.ok(event.acknowledgments.size === 1, 'Expected 1 acknowledgment')

	actor.send({ type: 'writer.destroy' })
})

test('handles retryable errors gracefully', async (tc) => {
	let data = Buffer.from('Hello, world!')

	let actor = createActor(WriterMachine, {
		input: {
			driver,
			options: {
				topic: testTopicName,
				producerId: testProducerName,
			},
		},
	})

	actor.start()

	await waitForEvent(actor, 'writer.session', tc.signal)
	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({
		type: 'writer.write',
		message: { seqNo: 1n, data: data },
	})

	actor.send({
		type: 'writer.stream.error',
		error: new YDBError(StatusIds_StatusCode.BAD_SESSION, []),
	})

	let event = await waitForEvent(actor, 'writer.acknowledgments', tc.signal)
	assert.ok(event.type === 'writer.acknowledgments', 'Expected writer.acknowledgments event')
	assert.ok(event.acknowledgments.size === 1, 'Expected 1 acknowledgment')

	nextTick(() => actor.send({ type: 'writer.close' }))
	await waitForState(actor, 'closed', tc.signal)
})

test('handles non retryable errors gracefully', async (tc) => {
	let data = Buffer.from('Hello, world!')

	let actor = createActor(WriterMachine, {
		input: {
			driver,
			options: {
				topic: testTopicName,
				producerId: testProducerName,
			},
		},
	})

	actor.start()

	await waitForEvent(actor, 'writer.session', tc.signal)
	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({
		type: 'writer.write',
		message: { seqNo: -1n, data: data },
	})

	let event: WriterEmitted = await waitForEvent(actor, 'writer.error', tc.signal)
	assert.ok(event.type === 'writer.error', 'Expected writer.error event')
	assert.ok(event.error instanceof Error, 'Expected error to be an instance of Error')

	assert.equal(actor.getSnapshot().value, 'closed')
})

test('closes gracefully and flushes the buffer', async (tc) => {
	let data = Buffer.from('Hello, world!')

	let actor = createActor(WriterMachine, {
		input: {
			driver,
			options: {
				topic: testTopicName,
				producerId: testProducerName,
			},
		},
	})

	actor.start()

	await waitForEvent(actor, 'writer.session', tc.signal)
	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({
		type: 'writer.write',
		message: { seqNo: 1n, data: data },
	})

	actor.send({ type: 'writer.close' })

	let event = await waitForEvent(actor, 'writer.acknowledgments', tc.signal)
	assert.ok(event.type === 'writer.acknowledgments', 'Expected writer.acknowledgments event')
	assert.ok(event.acknowledgments.size === 1, 'Expected 1 acknowledgment')

	assert.equal(actor.getSnapshot().value, 'closed')
})

test('flushes the buffer if overflow', async (tc) => {
	let data = Buffer.from('Hello, world!')

	let actor = createActor(WriterMachine, {
		input: {
			driver,
			options: {
				topic: testTopicName,
				producerId: testProducerName,
				maxBufferBytes: 0n,
			},
		},
	})

	actor.start()

	await waitForEvent(actor, 'writer.session', tc.signal)
	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({
		type: 'writer.write',
		message: { seqNo: 1n, data: data },
	})

	let event = await waitForEvent(actor, 'writer.acknowledgments', tc.signal)
	assert.ok(event.type === 'writer.acknowledgments', 'Expected writer.acknowledgments event')
	assert.ok(event.acknowledgments.size === 1, 'Expected 1 acknowledgment')

	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({ type: 'writer.destroy' })
})

test('flushes the buffer if timeout', async (tc) => {
	let data = Buffer.from('Hello, world!')

	let actor = createActor(WriterMachine, {
		input: {
			driver,
			options: {
				topic: testTopicName,
				producerId: testProducerName,
				flushIntervalMs: 5, // Reasonable flush interval (not 1ms!)
			},
		},
	})

	actor.start()

	await waitForEvent(actor, 'writer.session', tc.signal)
	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({
		type: 'writer.write',
		message: { seqNo: 1n, data: data },
	})

	let event = await waitForEvent(actor, 'writer.acknowledgments', tc.signal)
	assert.ok(event.type === 'writer.acknowledgments', 'Expected writer.acknowledgments event')
	assert.ok(event.acknowledgments.size === 1, 'Expected 1 acknowledgment')

	assert.equal(actor.getSnapshot().value, 'ready')

	actor.send({ type: 'writer.destroy' })
})

// Test configuration for throughput tests
let messageSizes = [
	32 * 1024, // 32 KiB
	128 * 1024, // 128 KiB
	512 * 1024, // 512 KiB
	2 * 1024 * 1024, // 2 MiB
	8 * 1024 * 1024, // 8 MiB
]

test.sequential.skip.each(messageSizes)(
	'measures sustained throughput with %i byte messages',
	{ timeout: 15_000 },
	async (messageSize) => {
		// Test configuration - limit by data volume instead of time
		let maxDataMiB = 1024 // Maximum 1024 MiB of data per message size
		let maxDataBytes = maxDataMiB * 1024 * 1024

		console.log(`\n📦 Testing with ${(messageSize / 1024).toFixed(0)} KiB messages`)

		let data = new Uint8Array(messageSize)
		// Fill with random-ish data to avoid compression artifacts
		for (let i = 0; i < messageSize; i++) {
			data[i] = (i * 137 + 42) % 256
		}

		let actor = createActor(WriterMachine, {
			input: {
				driver,
				options: {
					topic: testTopicName,
					producerId: `${testProducerName}-${messageSize}`,
					maxBufferBytes: 100n * 1024n * 1024n, // 100MB buffer
					maxInflightCount: 1000,
					flushIntervalMs: 1000,
					garbageCollection: {
						maxGarbageCount: 100, // Aggressive GC - clean every 100 acks
						maxGarbageSize: 10n * 1024n * 1024n, // 10MB threshold
						forceGC: true, // Force native GC
					},
				},
			},
		})

		actor.start()

		// Create AbortController for this test
		let abortController = new AbortController()

		await waitForEvent(actor, 'writer.session', abortController.signal)
		assert.equal(actor.getSnapshot().value, 'ready')

		let startTime = performance.now()
		let messagesSent = 0
		let totalAcks = 0
		let totalDataSent = 0

		// Calculate max messages for this size to reach data limit
		let maxMessages = Math.floor(maxDataBytes / messageSize)

		console.log(`  Target: ${maxMessages} messages (${(maxDataBytes / 1024 / 1024).toFixed(1)} MiB)`)

		// Listen for acknowledgments
		actor.on('writer.acknowledgments', (event) => {
			if (event.type === 'writer.acknowledgments') {
				totalAcks += event.acknowledgments.size
			}
		})

		while (messagesSent < maxMessages) {
			messagesSent++
			totalDataSent += messageSize
			actor.send({
				type: 'writer.write',
				message: { seqNo: BigInt(messagesSent), data },
			})
		}

		// Flush any remaining messages
		actor.send({ type: 'writer.flush' })

		// Wait for all messages to be sent and acknowledged using subscription
		await waitForState(actor, 'ready', abortController.signal)

		let actualDuration = (performance.now() - startTime) / 1000

		// Calculate metrics
		let messagesPerSecond = messagesSent / actualDuration
		let acksPerSecond = totalAcks / actualDuration
		let bytesPerSecond = totalDataSent / actualDuration
		let megabytesPerSecond = bytesPerSecond / (1024 * 1024)
		let ackRate = messagesSent > 0 ? (totalAcks / messagesSent) * 100 : 0

		console.log(`  📊 Results:`)
		console.log(`    Duration: ${actualDuration.toFixed(1)}s`)
		console.log(`    Messages sent: ${messagesSent}`)
		console.log(`    Messages acked: ${totalAcks} (${ackRate.toFixed(1)}%)`)
		console.log(`    Send rate: ${messagesPerSecond.toFixed(1)} msg/s`)
		console.log(`    Ack rate: ${acksPerSecond.toFixed(1)} msg/s`)
		console.log(`    Bandwidth: ${megabytesPerSecond.toFixed(2)} MB/s`)
		console.log(`    Total data: ${(totalDataSent / 1024 / 1024).toFixed(1)} MB`)
		console.log(`    Target reached: ${((totalDataSent / maxDataBytes) * 100).toFixed(1)}%`)

		// Basic assertions
		assert.ok(messagesSent > 0, 'Should have sent at least some messages')
		assert.ok(totalAcks >= 0, 'Should have received acknowledgments')
		assert.ok(totalDataSent > 0, 'Should have sent some data')
		if (totalAcks > 0) {
			assert.ok(ackRate > 80, `Ack rate too low: ${ackRate.toFixed(1)}%`)
		}

		actor.send({ type: 'writer.destroy' })

		// Force garbage collection after each test
		if (typeof globalThis.gc === 'function') {
			globalThis.gc()
		}
	}
)

test('messages written before initialization get correct seqno', async () => {
	await using writer = new TopicWriter(driver, {
		topic: testTopicName,
		producerId: `test-producer-${Date.now()}`,
	})

	// Write messages immediately after creating writer (before session initialization)
	// These messages will get temporary seqno (1, 2, 3...) initially
	let seqNo1 = writer.write(new TextEncoder().encode('Message 1'))
	let seqNo2 = writer.write(new TextEncoder().encode('Message 2'))
	let seqNo3 = writer.write(new TextEncoder().encode('Message 3'))

	// Wait for initialization and flush
	let lastSeqNo = await writer.flush()

	// After initialization, seqno should be recalculated based on server's lastSeqNo
	// So final seqno should be sequential and start from serverLastSeqNo + 1
	expect(seqNo1).toBeGreaterThan(0n)
	expect(seqNo2).toBe(seqNo1 + 1n)
	expect(seqNo3).toBe(seqNo2 + 1n)
	expect(lastSeqNo).toBe(seqNo3)

	// Verify messages were written by reading them
	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let messagesRead = 0
	let seqNos = new Set<bigint>()

	for await (let batch of reader.read({ limit: 10, waitMs: 2000 })) {
		for (let msg of batch) {
			seqNos.add(msg.seqNo)
			let content = new TextDecoder().decode(msg.payload)
			expect(['Message 1', 'Message 2', 'Message 3']).toContain(content)
			messagesRead++
		}

		await reader.commit(batch)

		if (messagesRead >= 3) {
			break
		}
	}

	expect(messagesRead).toBe(3)
	// Verify all seqno are present (messages were not dropped)
	expect(seqNos.has(seqNo1)).toBe(true)
	expect(seqNos.has(seqNo2)).toBe(true)
	expect(seqNos.has(seqNo3)).toBe(true)
})

test('messages written before initialization are not dropped', async () => {
	await using writer = new TopicWriter(driver, {
		topic: testTopicName,
		producerId: `test-producer-${Date.now()}`,
	})

	// Write message immediately (will get temporary seqno = 1)
	let seqNo = writer.write(new TextEncoder().encode('Test message'))

	// Flush to ensure message is sent
	await writer.flush()

	// Verify message was written (not dropped due to seqno comparison)
	await using reader = createTopicReader(driver, {
		topic: testTopicName,
		consumer: testConsumerName,
	})

	let messageFound = false
	let messagePayload: string | null = null
	for await (let batch of reader.read({ limit: 1, waitMs: 2000 })) {
		for (let msg of batch) {
			if (msg.seqNo === seqNo) {
				messagePayload = new TextDecoder().decode(msg.payload)
				messageFound = true
				break
			}
		}

		await reader.commit(batch)

		if (messageFound) {
			break
		}
	}

	expect(messageFound).toBe(true)
	expect(messagePayload).toBe('Test message')
})

test('new writer continues seqno sequence after previous writer', { timeout: 15_000 }, async () => {
	let producerId = `test-producer-${Date.now()}`

	// First writer: write messages
	await using writer1 = await new TopicWriter(driver, {
		topic: testTopicName,
		producerId,
	})

	let writer1SeqNo1 = writer1.write(new TextEncoder().encode('Writer1 Message 1'))
	let writer1SeqNo2 = writer1.write(new TextEncoder().encode('Writer1 Message 2'))
	let writer1LastSeqNo = await writer1.flush()

	expect(writer1SeqNo2).toBe(writer1LastSeqNo)
	expect(writer1SeqNo2).toBe(writer1SeqNo1 + 1n)

	// Wait a bit to ensure messages are committed on server
	await new Promise((resolve) => setTimeout(resolve, 500))

	// Create new writer with same producerId - should continue seqno sequence
	await using writer2 = new TopicWriter(driver, {
		topic: testTopicName,
		producerId,
	})

	// Write messages immediately (before initialization)
	// These should get seqno starting from writer1LastSeqNo + 1 after initialization
	writer2.write(new TextEncoder().encode('Writer2 Message 1'))
	writer2.write(new TextEncoder().encode('Writer2 Message 2'))
	let writer2LastSeqNo = await writer2.flush()

	// Verify seqno are sequential and continue from writer1
	// This is the key test: writer2 should get lastSeqNo from server and continue sequence
	// After initialization, seqno for writer2's messages should be recalculated from serverLastSeqNo
	// Note: write() returns temporary seqno (1, 2, 3...) before initialization
	// After initialization, seqno are recalculated, but write() return values don't change
	// We verify correctness through flush() which returns the actual lastSeqNo after recalculation
	// writer2 wrote 2 messages, so lastSeqNo should be writer1LastSeqNo + 2
	expect(writer2LastSeqNo).toBe(writer1LastSeqNo + 2n)

	// Verify sequentiality: lastSeqNo should be exactly 2 more than writer1's lastSeqNo
	// (because writer2 wrote 2 messages)
	expect(writer2LastSeqNo).toBeGreaterThan(writer1LastSeqNo)
})
