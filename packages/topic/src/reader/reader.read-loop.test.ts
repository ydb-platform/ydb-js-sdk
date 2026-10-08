import { expect, test } from 'vitest'

import { createTopicReader } from './index.ts'
import {
	initResponse,
	makeFakeTopicDriver,
	readResponse,
	settle,
	startPartitionSession,
} from './reader.fixtures.ts'

// read()-loop semantics against a fake streamRead: limit validation, abort
// mid-accumulation, and flow-control overdraw by an oversized response. The happy-path
// batching/credit wiring is covered by reader.contract.test.ts.

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

let text = function text(payload: Uint8Array): string {
	return new TextDecoder().decode(payload)
}

// The reader's flow-control requests, in send order (initial credit + replenishments).
let readRequests = function readRequests(
	sent: Array<{ clientMessage: { case?: string; value?: unknown } }>
): bigint[] {
	return sent
		.filter((m) => m.clientMessage.case === 'readRequest')
		.map((m) => (m.clientMessage.value as { bytesSize: bigint }).bytesSize)
}

// init handshake + read-credit grant, the precondition for every test below.
let primeStream = async function primeStream(
	reader: ReturnType<typeof createTopicReader>,
	waitForNextStream: ReturnType<typeof makeFakeTopicDriver>['waitForNextStream'],
	sessionId = 'session-A'
) {
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(sessionId))
	await stream.waitForReadRequest()
	return stream
}

// A non-positive limit is rejected up front, mirroring the writer's
// maxInflightCount guard — an unvalidated limit=0 would spin the batch-split loop
// forever instead of erroring.
test('rejects a zero read limit', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	// A buffered message makes the batch non-empty, so a missing guard is observable
	// as an immediate empty yield instead of a blocked take().
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	await settle()

	let firstBatch = async () => {
		let iterator = reader.read({ limit: 0, signal: tc.signal })[Symbol.asyncIterator]()
		return await iterator.next()
	}
	await expect(firstBatch()).rejects.toThrow(/limit/)
})

// Server-controlled response boundaries make a fixed message-count overflow
// nondeterministic on a live server, even when the response fits the byte budget.
test('delivers a large batch of tiny messages without overflowing the argument stack', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	let count = 150_000
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			bytesSize: 4_000_000n,
			messages: Array.from({ length: count }, (_, i) => ({
				offset: BigInt(i),
				seqNo: BigInt(i + 1),
				data: new Uint8Array([i % 256]),
			})),
		})
	)
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch).toHaveLength(count)
		expect(batch[0]!.offset).toBe(0n)
		expect(batch.at(-1)!.offset).toBe(BigInt(count - 1))
		break
	}
})

// Same invariant as above: a negative limit fails validation.
test('rejects a negative read limit', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	await settle()

	let firstBatch = async () => {
		let iterator = reader.read({ limit: -1, signal: tc.signal })[Symbol.asyncIterator]()
		return await iterator.next()
	}
	await expect(firstBatch()).rejects.toThrow(/limit/)
})

// An aborted read() consumes nothing: messages dequeued into the pending batch but
// never yielded stay with the reader, and a fresh read() redelivers them — a
// cancelled batch read loses no data.
test('redelivers messages dequeued by an aborted read()', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
				{ offset: 2n, seqNo: 3n, data: bytes('c') },
			],
			bytesSize: 300n,
		})
	)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 3n, seqNo: 4n, data: bytes('d') },
				{ offset: 4n, seqNo: 5n, data: bytes('e') },
			],
			bytesSize: 200n,
		})
	)
	await settle()
	expect(reader.bufferedBytes).toBe(500n)

	// Long window, no limit: both chunks are dequeued into the pending batch, then
	// read() blocks waiting for more. Abort during that wait.
	let ac = new AbortController()
	let thrown: unknown
	let consume = (async () => {
		try {
			for await (let batch of reader.read({ batchWindowMs: 60_000, signal: ac.signal })) {
				void batch
			}
		} catch (error) {
			thrown = error
		}
	})()
	await settle()
	ac.abort(new Error('consumer aborted'))
	await consume
	expect(String(thrown)).toContain('consumer aborted')
	expect(readRequests(stream.sent)).toEqual([1000n])
	expect(reader.bufferedBytes).toBe(500n)

	// Nothing was yielded, so nothing may be lost: a fresh read() delivers 0..4.
	// Bounded by idle windows so a redelivery failure cannot hang the suite.
	let redelivered: bigint[] = []
	let idleWindows = 0
	for await (let batch of reader.read({ batchWindowMs: 10, signal: tc.signal })) {
		if (batch.length === 0) {
			idleWindows++
			if (idleWindows >= 5) {
				break
			}
			continue
		}
		for (let message of batch) {
			redelivered.push(message.offset!)
		}
		if (redelivered.length >= 5) {
			break
		}
	}
	expect(redelivered).toEqual([0n, 1n, 2n, 3n, 4n])
	// Both response boundaries completed in the yielded batch, so their exact combined
	// server-accounted size is returned only now.
	expect(readRequests(stream.sent)).toEqual([1000n, 500n])
	expect(reader.bufferedBytes).toBe(0n)
})

test('accepts an oversized response and replenishes the full server-reported bytes', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1024n,
	})

	let stream = await primeStream(reader, waitForNextStream)
	expect(readRequests(stream.sent)).toEqual([1024n])

	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	// A single message may legitimately exceed the granted window; the server delivers
	// it anyway and reports its actual bytesSize. The reader must accept the overdraw
	// rather than fault or clamp.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			bytesSize: 5000n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('oversized') }],
		})
	)

	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch.map((m) => text(m.payload))).toEqual(['oversized'])
		break
	}
	await settle()

	// The replenishment uses the server-reported size, not one clamped to the budget —
	// a clamp would leak window bytes and eventually starve the reader of credit.
	expect(readRequests(stream.sent)).toEqual([1024n, 5000n])

	// Not stalled: a subsequent response still flows and replenishes normally.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			bytesSize: 600n,
			messages: [{ offset: 1n, seqNo: 2n, data: bytes('next') }],
		})
	)
	for await (let batch of reader.read({ limit: 1, signal: tc.signal })) {
		expect(batch.map((m) => m.offset)).toEqual([1n])
		break
	}
	await settle()
	expect(readRequests(stream.sent)).toEqual([1024n, 5000n, 600n])
})
