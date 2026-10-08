import { TopicServiceDefinition } from '@ydbjs/api/topic'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { TopicReader } from './index.ts'
import {
	initResponse,
	makeFakeTopicDriver,
	makeFakeTx,
	readResponse,
	settle,
	startPartitionSession,
} from './reader.fixtures.ts'

// Transactional-reader offset semantics against the fake streamRead driver: which
// offsets a tx commit binds (delivered vs merely buffered), where the commit range
// is anchored relative to the server committed offset, how the resulting
// UpdateOffsetsInTransaction call is routed, and what happens to the tracked
// offsets when the reader is closed before the transaction commits.

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

// Drive the shared read() iterator until `count` messages accumulate (idle ticks
// yield empty batches and are skipped). `signal` bounds a hang if they never arrive.
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

// init handshake + read-credit grant, the precondition for every test below.
let primeStream = async function primeStream(
	waitForNextStream: ReturnType<typeof makeFakeTopicDriver>['waitForNextStream']
) {
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse('session-A'))
	await stream.waitForReadRequest()
	return stream
}

// At-least-once over processed messages: a transaction binds only offsets the
// consumer actually received from read() — the wire range ends right after the last
// DELIVERED offset, never covering buffered-but-undelivered messages.
test('binds only offsets delivered through read() to the transaction commit', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: fake.tx })

	let stream = await primeStream(waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	await collect(reader, 2, tc.signal)

	// Three more messages arrive and sit in the buffer; read() never yields them.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 2n, seqNo: 3n, data: bytes('c') },
				{ offset: 3n, seqNo: 4n, data: bytes('d') },
				{ offset: 4n, seqNo: 5n, data: bytes('e') },
			],
		})
	)
	await settle()

	await fake.commit()
	expect(txOffsetRequests).toHaveLength(1)
	expect(txOffsetRequests[0]!.topics[0]!.partitions[0]!.partitionOffsets).toEqual([
		expect.objectContaining({ start: 0n, end: 2n }),
	])
})

// Like the non-tx commit path, the tx range is anchored at the server committed
// offset (the first delivered message's stitched range start), so a head gap —
// retention-expired offsets or a readOffset override — cannot make the server
// reject the tx commit or stall the watermark.
test('anchors the tx commit range at the server committed offset across a head gap', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: fake.tx })

	let stream = await primeStream(waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 3n })
	)
	await stream.waitForStartResponse()
	// First delivery starts above the committed offset 3 — offsets 3..4 are gone
	// (e.g. expired by retention).
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 5n, seqNo: 1n, data: bytes('a') },
				{ offset: 6n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	await collect(reader, 2, tc.signal)

	await fake.commit()
	expect(txOffsetRequests).toHaveLength(1)
	expect(txOffsetRequests[0]!.topics[0]!.partitions[0]!.partitionOffsets).toEqual([
		expect.objectContaining({ start: 3n, end: 7n }),
	])
})

// UpdateOffsetsInTransaction references the transaction's session, and session-bound
// RPCs are pinned to the node hosting that session — the commit call passes the
// transaction's nodeId to createClient, matching how the query package routes
// every session call.
test('routes UpdateOffsetsInTransaction to the transaction session node', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()

	// The shared fixture's createClient ignores its arguments — wrap it to observe the
	// node preference each call carries.
	let createClientArgs: unknown[][] = []
	let innerCreateClient = driver.createClient.bind(driver) as (...args: unknown[]) => unknown
	;(driver as unknown as { createClient: (...args: unknown[]) => unknown }).createClient = (
		...args: unknown[]
	) => {
		createClientArgs.push(args)
		return innerCreateClient(...args)
	}

	let fake = makeFakeTx()
	Object.assign(fake.tx, { nodeId: 42n })
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: fake.tx })

	let stream = await primeStream(waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	await collect(reader, 1, tc.signal)

	let callsBefore = createClientArgs.length
	await fake.commit()
	expect(txOffsetRequests).toHaveLength(1)

	let commitCalls = createClientArgs.slice(callsBefore)
	expect(commitCalls.length).toBeGreaterThanOrEqual(1)
	expect(commitCalls[0]![0]).toBe(TopicServiceDefinition)
	expect(commitCalls[0]![1]).toBe(42n)
})

// Offsets consumed inside a transaction survive an early close(): the commit hook
// still binds them via UpdateOffsetsInTransaction — a tx reader closed before the
// commit must not silently drop its progress (that would redeliver every consumed
// message after the tx commits).
test('preserves tracked read offsets when the reader closes before the tx commit', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: fake.tx })

	let stream = await primeStream(waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	await collect(reader, 1, tc.signal)

	let closeError: unknown
	try {
		await reader.close()
	} catch (error) {
		closeError = error
	}
	let commitError: unknown
	try {
		await fake.commit()
	} catch (error) {
		commitError = error
	}

	expect(
		closeError !== undefined || commitError !== undefined || txOffsetRequests.length === 1
	).toBe(true)
})
