import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { TopicReader, createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	failureResponse,
	initResponse,
	makeFakeTopicDriver,
	readResponse,
	settle,
	startPartitionSession,
} from './reader.fixtures.ts'

// End-to-end wiring of the reader facade against a fake streamRead: driver ↔ transport
// ↔ FSM ↔ read()/commit(), including transparent reconnect. The pure transition logic
// is covered by reader-state.test.ts / reader.model.test.ts; the protocol truth by the
// real-YDB reader-protocol.test.ts. These assert the integration in between.

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

let text = function text(payload: Uint8Array): string {
	return new TextDecoder().decode(payload)
}

// Drive the shared read() iterator until `count` messages accumulate (idle ticks yield
// empty batches and are skipped). `tc.signal` bounds a hang if the count never arrives.
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

test('requests the full buffer as read credit after init', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using _reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 4096n,
	})

	let stream = await waitForNextStream()
	let init = await stream.waitForInit()
	expect(init.consumer).toBe('c')

	stream.respond(initResponse())
	let read = await stream.waitForReadRequest()
	expect(read.bytesSize).toBe(4096n)
})

test('acknowledges a started partition session with its id', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 7n, partitionId: 3n }))

	let ack = await stream.waitForStartResponse()
	expect(ack.partitionSessionId).toBe(7n)
})

test('surfaces decoded messages through read()', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

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
		})
	)

	let messages = await collect(reader, 3, tc.signal)
	expect(messages.map((m) => text(m.payload))).toEqual(['a', 'b', 'c'])
	expect(messages.map((m) => m.offset)).toEqual([0n, 1n, 2n])
})

test('honors the deprecated waitMs alias for batchWindowMs', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	// No data arrives. With the alias wired, read({ waitMs }) yields an empty batch each
	// window; without it batchWindowMs would be undefined and read() would block forever.
	let iterator = reader.read({ waitMs: 10, signal: tc.signal })[Symbol.asyncIterator]()
	let first = await iterator.next()
	expect(first.done).toBe(false)
	expect(first.value).toEqual([])
	await iterator.return?.()
})

test('resolves commit() when the server acknowledges the offset', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
		})
	)

	let [message] = await collect(reader, 1, tc.signal)
	let commit = reader.commit(message!)

	let request = await stream.waitForCommit()
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(1n)
	// offset 0 → range [0, 1); resolves once committed_offset reaches 1.
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(1n)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	await expect(commit).resolves.toBeUndefined()
})

test('does not reject commit() across a reconnect and resolves it on the new session', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	// Session A: read [0,1,2], commit offset 2 (range [0,3)), but the server never acks.
	let a = await primeStream(reader, waitForNextStream, 'session-A')
	a.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await a.waitForStartResponse()
	a.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
				{ offset: 2n, seqNo: 3n, data: bytes('c') },
			],
		})
	)
	let messages = await collect(reader, 3, tc.signal)
	let commit = reader.commit(messages[2]!)
	await a.waitForCommit()

	// The stream drops before the ack. The reader must NOT reject the in-flight commit.
	a.disconnect()

	// Session B: same partition, fresh session id, committed still 0. The reconcile must
	// re-send the pending [committed, 3) on the new session id.
	let b = await waitForNextStream()
	await b.waitForInit()
	b.respond(initResponse('session-B'))
	await b.waitForReadRequest()
	b.respond(
		startPartitionSession({ partitionSessionId: 2n, partitionId: 10n, committedOffset: 0n })
	)

	let resent = await b.waitForCommit()
	expect(resent.commitOffsets[0]!.partitionSessionId).toBe(2n)
	expect(resent.commitOffsets[0]!.offsets[0]!.end).toBe(3n)

	// The server acks on B → the original commit() promise resolves (never rejected).
	b.respond(commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 3n }]))
	await expect(commit).resolves.toBeUndefined()
})

test('a tx reader tracks read offsets by partition across a reconnect', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	// A tx reader (any truthy tx enables offset tracking in the facade — the FSM is
	// tx-agnostic). We assert txReadOffsetUpdates() directly, so a bare fake tx suffices.
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: {} as never })

	let a = await primeStream(reader, waitForNextStream, 'session-A')
	a.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await a.waitForStartResponse()
	a.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 5n, seqNo: 1n, data: bytes('a') },
				{ offset: 6n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	await collect(reader, 2, tc.signal)

	let updates = reader.txReadOffsetUpdates()
	expect(updates).toHaveLength(1)
	expect(updates[0]!.offsetRange).toEqual({ firstOffset: 5n, lastOffset: 6n })

	// Reconnect: same partition, fresh session id. The facade keys by the stable
	// partitionId, so the tracked range must survive and extend.
	a.disconnect()
	let b = await waitForNextStream()
	await b.waitForInit()
	b.respond(initResponse('session-B'))
	await b.waitForReadRequest()
	b.respond(
		startPartitionSession({ partitionSessionId: 2n, partitionId: 10n, committedOffset: 5n })
	)
	await b.waitForStartResponse()
	b.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 7n, seqNo: 3n, data: bytes('c') }],
		})
	)
	await collect(reader, 1, tc.signal)

	let after = reader.txReadOffsetUpdates()
	expect(after).toHaveLength(1)
	expect(after[0]!.offsetRange).toEqual({ firstOffset: 5n, lastOffset: 7n })
})

test('reopens the stream after a transport drop', async () => {
	let { driver, waitForNextStream, streamCount } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let a = await primeStream(reader, waitForNextStream, 'session-A')
	a.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await a.waitForStartResponse()
	expect(streamCount()).toBe(1)

	a.disconnect()

	// A clean end with no error is a retryable server-side reconnect: a new stream opens
	// and re-sends the init handshake.
	let b = await waitForNextStream()
	let init = await b.waitForInit()
	expect(init.consumer).toBe('c')
	expect(streamCount()).toBe(2)
})

test('fails terminally on a non-retryable status and rejects the pending commit', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
		})
	)

	let [message] = await collect(reader, 1, tc.signal)
	let commit = reader.commit(message!)
	await stream.waitForCommit()

	// SCHEME_ERROR is never retryable → the reader terminates instead of reconnecting.
	stream.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(commit).rejects.toThrow(YDBError)
	await expect(reader.close()).rejects.toThrow(YDBError)
})

test('read() throws the terminal error instead of ending cleanly', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	let caught: unknown
	let loop = (async () => {
		try {
			for await (let batch of reader.read({ batchWindowMs: 20, signal: tc.signal })) {
				void batch
			}
		} catch (error) {
			caught = error
		}
	})()

	await settle()
	// A fatal, non-retryable status terminates the reader while read() is iterating: the
	// loop must throw, not end like a clean end-of-stream.
	stream.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))
	await loop

	expect(caught).toBeInstanceOf(YDBError)
	expect((caught as YDBError).code).toBe(StatusIds_StatusCode.SCHEME_ERROR)
})

test('retryOnSchemeError keeps reconnecting on SCHEME_ERROR instead of terminating', async () => {
	let { driver, waitForNextStream, streamCount } = makeFakeTopicDriver()
	using _reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		retryOnSchemeError: true,
	})

	// The topic does not exist yet: the server rejects the init with SCHEME_ERROR.
	let a = await waitForNextStream()
	await a.waitForInit()
	a.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	// Instead of failing, the reader backs off and re-inits on a fresh stream — twice,
	// proving it is unbounded (the terminal recovery window is never armed by default).
	let b = await waitForNextStream()
	await b.waitForInit()
	b.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	let c = await waitForNextStream()
	await c.waitForInit()
	expect(streamCount()).toBeGreaterThanOrEqual(3)

	// Once the topic is created, the init succeeds and the reader proceeds normally.
	c.respond(initResponse('session-C'))
	await c.waitForReadRequest()
	c.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	let started = await c.waitForStartResponse()
	expect(started.partitionSessionId).toBe(1n)
})

test('replenishes read credit once the consumer drains a batch', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 100n,
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	// A response that charges the whole buffer; consuming it must free the credit back.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			bytesSize: 100n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('payload') }],
		})
	)

	let iterator = reader.read({ batchWindowMs: 5 })[Symbol.asyncIterator]()
	await iterator.next() // take the batch
	// Resume past the yield so the read-release dispatches. This next() may reject with
	// the terminal error once the reader is destroyed at teardown — swallow it (it is not
	// the assertion under test, and an un-awaited rejection would fail the run).
	iterator.next().catch(() => {})
	await settle()

	let reads = stream.sent.filter((m) => m.clientMessage.case === 'readRequest')
	expect(reads.length).toBeGreaterThanOrEqual(2)
	expect(reads.at(-1)!.clientMessage.value.bytesSize).toBe(100n)
})

test('publishes partition-started and committed diagnostics', async (tc) => {
	let started: { partitionId: bigint; committedOffset: bigint }[] = []
	let committed: { partitionId: bigint; committedOffset: bigint }[] = []
	let onStarted = (m: unknown): void => {
		started.push(m as { partitionId: bigint; committedOffset: bigint })
	}
	let onCommitted = (m: unknown): void => {
		committed.push(m as { partitionId: bigint; committedOffset: bigint })
	}
	subscribe('ydb:topic.reader.partition.started', onStarted)
	subscribe('ydb:topic.reader.committed', onCommitted)

	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

		let stream = await primeStream(reader, waitForNextStream)
		stream.respond(
			startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
		)
		await stream.waitForStartResponse()
		stream.respond(
			readResponse({
				partitionSessionId: 1n,
				messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
			})
		)

		let [message] = await collect(reader, 1, tc.signal)
		let commit = reader.commit(message!)
		await stream.waitForCommit()
		stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
		await commit

		expect(started).toHaveLength(1)
		expect(started[0]!.partitionId).toBe(10n)
		expect(committed.at(-1)!.committedOffset).toBe(1n)
	} finally {
		unsubscribe('ydb:topic.reader.partition.started', onStarted)
		unsubscribe('ydb:topic.reader.committed', onCommitted)
	}
})

test('closes gracefully and aborts the underlying stream', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	await reader.close()
	await settle()
	expect(stream.wasAborted()).toBe(true)
})
