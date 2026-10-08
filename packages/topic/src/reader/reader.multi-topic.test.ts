import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { TopicReader, createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	makeFakeTopicDriver,
	makeFakeTx,
	readResponse,
	settle,
	startPartitionSession,
} from './reader.fixtures.ts'

// A reader over several topics shares one streamRead. The protocol's unique
// per-stream key is partition_session_id; partition_id is per-topic, so two
// topics on one stream routinely present the same partition id (every topic
// has a partition 0). These tests pin that per-partition state (delivery,
// commit routing, tx offsets) stays separated per topic in that case.

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

let text = function text(payload: Uint8Array): string {
	return new TextDecoder().decode(payload)
}

// Drive the shared read() iterator until `count` messages accumulate (idle ticks
// yield empty batches and are skipped). `tc.signal` bounds a hang.
let collect = async function collect(
	reader: TopicReader,
	count: number,
	signal: AbortSignal
): Promise<TopicMessage[]> {
	let out: TopicMessage[] = []
	for await (let batch of reader.read({ batchWindowMs: 5, signal })) {
		out.push(...batch)
		if (out.length >= count) {
			break
		}
	}
	return out
}

// Like collect, but bounded: gives up after 20 consecutive empty batch windows
// so a never-delivered message surfaces as a short result, not a hang.
let collectUpTo = async function collectUpTo(
	reader: TopicReader,
	count: number,
	signal: AbortSignal
): Promise<TopicMessage[]> {
	let out: TopicMessage[] = []
	let idle = 0
	for await (let batch of reader.read({ batchWindowMs: 5, signal })) {
		if (batch.length === 0) {
			idle += 1
			if (idle >= 20) {
				break
			}
		} else {
			idle = 0
			out.push(...batch)
		}
		if (out.length >= count) {
			break
		}
	}
	return out
}

// init handshake + read-credit grant, the precondition for every test below.
let primeStream = async function primeStream(
	reader: TopicReader,
	waitForNextStream: ReturnType<typeof makeFakeTopicDriver>['waitForNextStream'],
	sessionId = 'session-A'
) {
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(sessionId))
	await stream.waitForReadRequest()
	return stream
}

// The fixture's waitForStartResponse resolves with the FIRST ack on the wire;
// this waits until the ack for a specific partition session id shows up.
let waitForStartAck = async function waitForStartAck(
	stream: Awaited<ReturnType<ReturnType<typeof makeFakeTopicDriver>['waitForNextStream']>>,
	partitionSessionId: bigint
): Promise<void> {
	for (;;) {
		let acked = stream.sent.some(
			(m) =>
				m.clientMessage.case === 'startPartitionSessionResponse' &&
				m.clientMessage.value.partitionSessionId === partitionSessionId
		)
		if (acked) {
			return
		}
		// oxlint-disable-next-line no-await-in-loop
		await settle(10)
	}
}

// Partition state is keyed by (topicPath, partitionId): two topics granting the
// same partition id on one stream stay independent, and each topic's messages are
// delivered.
test('delivers messages from both topics when their partition ids collide', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: [{ path: '/a' }, { path: '/b' }],
		consumer: 'c',
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, path: '/a' }))
	await waitForStartAck(stream, 1n)
	stream.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 0n, path: '/b' }))
	await waitForStartAck(stream, 2n)

	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('from-a') }],
		})
	)
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('from-b') }],
		})
	)

	let messages = await collectUpTo(reader, 2, tc.signal)
	expect(messages.map((m) => text(m.payload)).sort()).toEqual(['from-a', 'from-b'])
	expect(messages.map((m) => m.partitionSession.deref()?.topicPath).sort()).toEqual(['/a', '/b'])
})

// commit() routes by the message's (topicPath, partitionId): another topic's grant
// with the same partition id cannot capture the commit — it is sent under the
// session the message was read from.
test('commits a first-topic message under its own partition session', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: [{ path: '/a' }, { path: '/b' }],
		consumer: 'c',
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({
			partitionSessionId: 1n,
			partitionId: 0n,
			path: '/a',
			committedOffset: 0n,
		})
	)
	await waitForStartAck(stream, 1n)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('from-a') }],
		})
	)
	let [message] = await collect(reader, 1, tc.signal)
	expect(message!.partitionSession.deref()?.topicPath).toBe('/a')

	stream.respond(
		startPartitionSession({
			partitionSessionId: 2n,
			partitionId: 0n,
			path: '/b',
			committedOffset: 0n,
		})
	)
	await waitForStartAck(stream, 2n)

	let commit = reader.commit(message!)
	commit.catch(() => {}) // settled below on the ack; avoid an unhandled rejection on teardown

	let request = await stream.waitForCommit()
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(1n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(1n)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	await expect(commit).resolves.toBeUndefined()
})

// The tx reader tracks read offsets per (topicPath, partitionId):
// UpdateOffsetsInTransaction carries one TopicOffsets entry per topic, each with
// only its own partition's range, even when partition ids collide across topics.
test('attributes tx offset ranges to each topic when partition ids collide', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using reader = new TopicReader(
		driver,
		{ topic: [{ path: '/a' }, { path: '/b' }], consumer: 'c' },
		{ tx: fake.tx }
	)

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({
			partitionSessionId: 1n,
			partitionId: 0n,
			path: '/a',
			committedOffset: 5n,
		})
	)
	await waitForStartAck(stream, 1n)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 5n, seqNo: 1n, data: bytes('a1') },
				{ offset: 6n, seqNo: 2n, data: bytes('a2') },
			],
		})
	)
	await collect(reader, 2, tc.signal)

	stream.respond(
		startPartitionSession({
			partitionSessionId: 2n,
			partitionId: 0n,
			path: '/b',
			committedOffset: 100n,
		})
	)
	await waitForStartAck(stream, 2n)
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 100n, seqNo: 1n, data: bytes('b1') }],
		})
	)
	await collect(reader, 1, tc.signal)

	await fake.commit()
	expect(txOffsetRequests).toHaveLength(1)
	let topics = txOffsetRequests[0]!.topics
	expect(topics).toHaveLength(2)
	let byPath = new Map(topics.map((t) => [t.path, t.partitions]))
	expect(byPath.get('/a')).toEqual([
		expect.objectContaining({
			partitionId: 0n,
			partitionOffsets: [expect.objectContaining({ start: 5n, end: 7n })],
		}),
	])
	expect(byPath.get('/b')).toEqual([
		expect.objectContaining({
			partitionId: 0n,
			partitionOffsets: [expect.objectContaining({ start: 100n, end: 101n })],
		}),
	])
})
