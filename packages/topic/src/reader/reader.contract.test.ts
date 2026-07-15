import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import * as zlib from 'node:zlib'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Codec } from '@ydbjs/api/topic'
import type { StreamReadMessage_FromServer } from '@ydbjs/api/topic'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import { ZSTD_CODEC } from '../codec.ts'
import type { TopicMessage } from '../message.ts'
import type { TopicPartitionSession } from '../partition-session.ts'
import { TopicReader, createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	failureResponse,
	initResponse,
	makeFakeTopicDriver,
	makeFakeTx,
	readResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
	updateTokenResponse,
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

// Subscribe to an event channel and gather its payloads; `using` auto-unsubscribes.
// (The writer twin names this `collect` — here that name is the message collector.)
let capture = function capture<T = unknown>(name: string): { payloads: T[] } & Disposable {
	let payloads: T[] = []
	let fn = (message: unknown) => payloads.push(message as T)
	subscribe(name, fn)
	return {
		payloads,
		[Symbol.dispose]() {
			unsubscribe(name, fn)
		},
	}
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

// endPartitionSession is informational ("partition fully read") — not in the shared
// fixtures because only these tests exercise it.
let endPartitionSession = function endPartitionSession(
	partitionSessionId: bigint
): StreamReadMessage_FromServer {
	return {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'endPartitionSession',
			value: { partitionSessionId, adjacentPartitionIds: [], childPartitionIds: [] },
		},
	} as unknown as StreamReadMessage_FromServer
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

test('requests the full buffer as read credit after init', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 4096n,
	})
	void reader // kept alive by `using`; the test drives the wire directly

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

test('a tx reader binds offsets read across a reconnect to the transaction commit', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: fake.tx })

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

	// The tx commit sends one UpdateOffsetsInTransaction with the merged (grow-only)
	// range spanning both sessions — the wire is the observable contract here.
	await fake.commit()
	expect(txOffsetRequests).toHaveLength(1)
	let request = txOffsetRequests[0]!
	expect(request.consumer).toBe('c')
	expect(request.tx).toMatchObject({ id: 'tx-1', session: 'tx-session' })
	expect(request.topics).toHaveLength(1)
	expect(request.topics[0]!.partitions).toEqual([
		expect.objectContaining({
			partitionId: 10n,
			partitionOffsets: [expect.objectContaining({ start: 5n, end: 8n })],
		}),
	])
})

test('throws on a manual commit() from a tx reader', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: makeFakeTx().tx })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	let [message] = await collect(reader, 1, tc.signal)

	// The TopicTxReader type hides commit(), but the method exists on the runtime
	// object — plain-JS callers must hit a hard error, not a commit that lands
	// outside the transaction and survives its rollback.
	expect(() => reader.commit(message!)).toThrow('Tx reader commits offsets via the transaction')
	expect(stream.sent.filter((m) => m.clientMessage.case === 'commitOffsetRequest')).toHaveLength(
		0
	)
})

test('renders the tx distinction in the inspect tag', () => {
	let { driver } = makeFakeTopicDriver()
	using plain = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	using tx = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: makeFakeTx().tx })

	expect(Object.prototype.toString.call(plain)).toBe('[object TopicReader]')
	expect(Object.prototype.toString.call(tx)).toBe('[object TopicTxReader]')
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
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		retryOnSchemeError: true,
	})
	void reader // kept alive by `using`; the test drives the wire directly

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

test('publishes session-started, partition-started, and committed diagnostics', async (tc) => {
	using sessions = capture<{ sessionId: string; consumer: string; topics: string[] }>(
		'ydb:topic.reader.session.started'
	)
	using started = capture<{ partitionId: bigint; committedOffset: bigint; topics: string[] }>(
		'ydb:topic.reader.partition.started'
	)
	using committed = capture<{ partitionId: bigint; committedOffset: bigint }>(
		'ydb:topic.reader.committed'
	)

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

	// session.started: once per (re)established read session, attributed to the
	// consumer and topics like the writer's is to its topic/producer.
	expect(sessions.payloads).toHaveLength(1)
	expect(sessions.payloads[0]).toMatchObject({ consumer: 'c', topics: ['/t'] })
	expect(sessions.payloads[0]!.sessionId.length).toBeGreaterThan(0)
	expect(started.payloads).toHaveLength(1)
	expect(started.payloads[0]!.partitionId).toBe(10n)
	expect(started.payloads[0]!.topics).toEqual(['/t'])
	expect(committed.payloads.at(-1)!.committedOffset).toBe(1n)
})

// node:zlib gained zstd in Node.js 22.15 / 23.8 — the roundtrip below needs it; the
// sibling test covers the graceful failure on runtimes without it (the Node 20 CI lane).
let runtimeHasZstd = typeof zlib.zstdCompressSync === 'function'

test.skipIf(!runtimeHasZstd)(
	'decodes a zstd-compressed batch delivered by the server',
	async (tc) => {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

		let stream = await primeStream(reader, waitForNextStream)
		stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
		await stream.waitForStartResponse()

		// Real zstd bytes on the wire — proves the default codec map decompresses ZSTD
		// end-to-end (fixtures otherwise deliver RAW, which decodes as identity).
		let payload = bytes('zstd payload that must round-trip through decompression')
		stream.respond(
			readResponse({
				partitionSessionId: 1n,
				codec: Codec.ZSTD,
				messages: [{ offset: 0n, seqNo: 1n, data: ZSTD_CODEC.compress(payload) }],
			})
		)

		let [message] = await collect(reader, 1, tc.signal)
		expect(text(message!.payload)).toBe(
			'zstd payload that must round-trip through decompression'
		)
		expect(message!.codec).toBe(Codec.ZSTD)
	}
)

test.skipIf(runtimeHasZstd)(
	'fails with the codecMap remedy on zstd data when the runtime lacks zstd',
	async (tc) => {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		let reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

		let stream = await primeStream(reader, waitForNextStream)
		stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
		await stream.waitForStartResponse()

		// Without runtime zstd the default codec map deliberately has no ZSTD entry, so
		// server-delivered zstd data must surface the actionable unknown-codec error
		// (register a custom codec in codecMap) instead of a bare zlib TypeError.
		stream.respond(
			readResponse({
				partitionSessionId: 1n,
				codec: Codec.ZSTD,
				messages: [{ offset: 0n, seqNo: 1n, data: bytes('zstd-compressed-elsewhere') }],
			})
		)

		let firstError: unknown
		try {
			await collect(reader, 1, tc.signal)
		} catch (error) {
			firstError = error
		}
		expect(String(firstError)).toMatch(/codec/i)
		expect(String(firstError)).toMatch(/codecMap/)
		reader.destroy()
	}
)

// ── commit protocol ────────────────────────────────────────────────────────────

test('sends only well-formed offset ranges when a message is committed twice', async (tc) => {
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

	let firstCommit = reader.commit(messages)
	await stream.waitForCommit()
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 3n }]))
	await firstCommit

	// At-least-once consumers legitimately re-commit (e.g. a retried handler). A
	// zero-width or inverted OffsetsRange on the wire is session-fatal (BAD_REQUEST
	// "double committing is forbiden"). (review B4)
	void reader.commit(messages[0]!).catch(() => {})
	await settle()

	let ranges = stream.sent
		.filter((m) => m.clientMessage.case === 'commitOffsetRequest')
		.flatMap((m) =>
			m.clientMessage.case === 'commitOffsetRequest'
				? m.clientMessage.value.commitOffsets.flatMap((c) => c.offsets)
				: []
		)
	for (let range of ranges) {
		expect(
			range.start < range.end,
			`malformed commit range [${range.start}, ${range.end}) sent to server`
		).toBe(true)
	}
})

// ── partition stop & handoff ───────────────────────────────────────────────────

test('resolves a pending commit covered by stop_partition committed_offset', async (tc) => {
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
	let messages = await collect(reader, 1, tc.signal)

	let commit = reader.commit(messages)
	await stream.waitForCommit()

	// The commit was applied server-side, but the ack raced a rebalance: the server
	// stops the partition (graceful=false) and reports the committed upper bound. The
	// commit() promise must resolve — not hang for the reassign-gc window and then
	// reject even though the offsets were committed. (review M3)
	stream.respond(
		stopPartitionSession({ partitionSessionId: 1n, graceful: false, committedOffset: 1n })
	)
	await settle()

	await expect(commit).resolves.toBeUndefined()
})

test('sends a commit issued during a graceful stop and completes the handoff', async (tc) => {
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
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	let messages = await collect(reader, 2, tc.signal)

	let commitFrames = () =>
		stream.sent.filter((m) => m.clientMessage.case === 'commitOffsetRequest').length
	let stopResponses = () =>
		stream.sent.filter((m) => m.clientMessage.case === 'stopPartitionSessionResponse').length

	// One commit in flight (server has not acked yet) → pendingCommits non-empty.
	let first = reader.commit(messages[0]!)
	await stream.waitForCommit()
	expect(commitFrames()).toBe(1)

	// The server starts a graceful handoff of the partition.
	stream.respond(stopPartitionSession({ partitionSessionId: 1n, graceful: true }))
	await settle()

	// The app finishes processing and commits the second message — the protocol allows
	// committing until the client answers the stop, so it must reach the wire. (B2)
	let second = reader.commit(messages[1]!)
	await settle()
	expect(commitFrames()).toBe(2)

	// The server acks everything → both commits resolve and the stop completes.
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 2n }]))
	await expect(first).resolves.toBeUndefined()
	await expect(second).resolves.toBeUndefined()
	await settle()
	expect(stopResponses()).toBe(1)
})

test('drops buffered messages of a force-stopped partition and still releases their credit', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	// Messages decoded into the facade chunk queue BEFORE the consumer pulls.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
			],
			bytesSize: 400n,
		})
	)
	await settle()
	// Force stop (rebalance) before read() runs: the partition's new owner re-reads
	// these messages, so delivering here would double-process. (review PARITY-4)
	stream.respond(stopPartitionSession({ partitionSessionId: 1n, graceful: false }))
	await settle()

	let delivered: unknown[] = []
	for await (let batch of reader.read({ batchWindowMs: 50 })) {
		delivered.push(...batch)
		break
	}
	await settle()

	expect(delivered.length).toBe(0)
	// The dropped chunk's flow-control credit was still returned to the server. (M7)
	expect(readRequests(stream.sent)).toEqual([1000n, 400n])
})

test('rejects a commit for a batch yielded before its partition force-stopped', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	// The batch is already out of the reader's hands when the rebalance strikes.
	let [message] = await collect(reader, 1, tc.signal)
	stream.respond(stopPartitionSession({ partitionSessionId: 1n, graceful: false }))
	await settle()

	// Committing it now targets the stopped session: fail fast with a clear error
	// instead of hanging or double-committing on the partition's new owner.
	await expect(reader.commit(message!)).rejects.toThrow('stopped or expired partition session')
})

test('invokes onPartitionSessionStop and keeps the reader alive on a force stop', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let stops: bigint[] = []
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: (session) => {
			stops.push(session.partitionId)
		},
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	stream.respond(stopPartitionSession({ partitionSessionId: 1n, graceful: false }))
	await settle()

	expect(stops).toEqual([10n])

	// The reader must keep serving other partitions after losing one.
	stream.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 11n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('y') }],
		})
	)
	let messages = await collect(reader, 1, tc.signal)
	expect(messages).toHaveLength(1)
})

// ── reconnect windows ──────────────────────────────────────────────────────────

test('buffers a commit issued before the reconnected stream re-grants the partition', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	// Session A: partition granted as session id 1, one message delivered.
	let a = await primeStream(reader, waitForNextStream, 'session-A')
	a.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await a.waitForStartResponse()
	a.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	let messages = await collect(reader, 1, tc.signal)

	// Transparent reconnect: session B inits, but start_partition has NOT arrived.
	a.disconnect()
	let b = await waitForNextStream()
	await b.waitForInit()
	b.respond(initResponse('session-B'))
	await b.waitForReadRequest()

	// A commit in the init→start_partition window: nothing may go out yet — session
	// id 1 belongs to stream A and stream B never granted it. (review B3)
	let commit = reader.commit(messages[0]!)
	await settle()
	let commitFrames = () =>
		b.sent.filter((m) => m.clientMessage.case === 'commitOffsetRequest').length
	expect(commitFrames()).toBe(0)

	// The partition comes back under a fresh session id — the reconcile re-sends the
	// buffered commit under the NEW id and the promise resolves on its ack.
	b.respond(
		startPartitionSession({ partitionSessionId: 2n, partitionId: 10n, committedOffset: 0n })
	)
	let resent = await b.waitForCommit()
	expect(resent.commitOffsets[0]!.partitionSessionId).toBe(2n)
	b.respond(commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 1n }]))
	await expect(commit).resolves.toBeUndefined()
})

// ── read() semantics ───────────────────────────────────────────────────────────

test('keeps the iterator alive past limit total messages (limit is a per-batch cap)', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	// Intentional parity break vs the pre-FSM reader (PARITY-6): limit used to be a
	// cumulative total that ENDED the iterator; now it only caps each batch.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
			],
		})
	)

	let iterable = reader.read({ limit: 2, batchWindowMs: 5, signal: tc.signal })
	let iterator = iterable[Symbol.asyncIterator]()

	let total = 0
	while (total < 2) {
		// oxlint-disable-next-line no-await-in-loop
		let r = await iterator.next()
		expect(r.done).toBe(false)
		total += (r.value as unknown[]).length
	}

	// Old semantics: next() resolves { done: true } here. New semantics: the iterator
	// keeps yielding window batches and still delivers new data past the limit.
	let afterLimit = await iterator.next()
	expect(afterLimit.done).toBe(false)

	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 2n, seqNo: 3n, data: bytes('c') }],
		})
	)
	let more: unknown[] = []
	while (more.length === 0) {
		// oxlint-disable-next-line no-await-in-loop
		let r = await iterator.next()
		expect(r.done).toBe(false)
		more = r.value as unknown[]
	}
	expect(more.length).toBe(1)

	await iterator.return?.()
})

test('throws a single-consumer error on a second concurrent read()', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	await primeStream(reader, waitForNextStream)

	let first = reader.read({ batchWindowMs: 10, signal: tc.signal })[Symbol.asyncIterator]()
	await first.next() // empty window tick — the generator body is now running

	let second = reader.read({ batchWindowMs: 10, signal: tc.signal })[Symbol.asyncIterator]()
	await expect(second.next()).rejects.toThrow('read() is already in progress')

	await first.return?.()
})

// ── codecs ─────────────────────────────────────────────────────────────────────

test('delivers a message with codec UNSPECIFIED as a raw payload', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	// UNSPECIFIED means "no codec recorded", not an error: the payload passes through
	// raw instead of destroying the whole reader. (review finding 5)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			codec: Codec.UNSPECIFIED,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('plain') }],
		})
	)

	let [message] = await collect(reader, 1, tc.signal)
	expect(text(message!.payload)).toBe('plain')
})

test('fails the reader with an actionable error on an unknown codec', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	// The protocol offers no way to refuse a single partition, so an unknown codec is
	// TERMINAL by design — but the error must be actionable (offset, partition, codec,
	// the codecMap remedy) and carry the original cause. (review PARITY-READER-3 / M8)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			codec: Codec.LZOP,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('lzop-compressed-elsewhere') }],
		})
	)

	let firstError: unknown
	try {
		for await (let batch of reader.read({ batchWindowMs: 5, signal: tc.signal })) {
			void batch
		}
	} catch (error) {
		firstError = error
	}
	expect(String(firstError)).toContain('offset 0 of partition 10')
	expect(String(firstError)).toContain('codec 3')
	expect(String(firstError)).toContain('codecMap')
	expect(String((firstError as Error).cause)).toContain('Unsupported codec: 3')

	// The reader is terminally dead: a fresh read() throws too — the whole
	// multi-partition reader is gone, not just the poisoned batch.
	let secondError: unknown
	try {
		for await (let batch of reader.read({ batchWindowMs: 5, signal: tc.signal })) {
			void batch
		}
	} catch (error) {
		secondError = error
	}
	expect(secondError).toBeDefined()

	await expect(reader.close()).rejects.toThrow('offset 0 of partition 10')
})

test('decodes with a custom codecMap entry for a non-built-in codec', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let reverse = (payload: Uint8Array) => Uint8Array.from(payload).reverse()
	await using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		codecMap: new Map([
			[Codec.LZOP, { codec: Codec.LZOP, compress: reverse, decompress: reverse }],
		]),
	})
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()

	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			codec: Codec.LZOP,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('cba') }],
		})
	)

	let [message] = await collect(reader, 1, tc.signal)
	expect(text(message!.payload)).toBe('abc')
})

test('fails the reader with a contextual error on a corrupt payload', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 7n }))
	await stream.waitForStartResponse()

	// A known codec whose decoder throws (garbage bytes): the fault must carry the
	// offset/partition/topic context and the decoder error as the cause. (review M8)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			codec: Codec.GZIP,
			messages: [{ offset: 42n, seqNo: 1n, data: bytes('definitely-not-gzip') }],
		})
	)

	let thrown: unknown
	try {
		for await (let batch of reader.read({ batchWindowMs: 5, signal: tc.signal })) {
			void batch
		}
	} catch (error) {
		thrown = error
	}
	expect(String(thrown)).toContain('offset 42 of partition 7')
	expect(String(thrown)).toContain('/t')
	expect((thrown as Error).cause).toBeDefined()

	// Terminal: commit and close surface the same fault.
	await expect(reader.commit([])).rejects.toThrow('offset 42 of partition 7')
	await expect(reader.close()).rejects.toThrow('offset 42 of partition 7')
})

// ── tx offsets ─────────────────────────────────────────────────────────────────

test('keeps tx offset ranges isolated per partition under equal and lower redelivery', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: fake.tx })
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 5n })
	)
	stream.respond(
		startPartitionSession({ partitionSessionId: 2n, partitionId: 20n, committedOffset: 100n })
	)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 5n, seqNo: 1n, data: bytes('a') },
				{ offset: 6n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 100n, seqNo: 1n, data: bytes('x') }],
		})
	)
	// Equal + lower offsets again on partition 10 (redelivery shape) — must not
	// rewind; partition 20 must stay untouched. (review M11: grow-only per partition)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 5n, seqNo: 1n, data: bytes('a') },
				{ offset: 6n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	await collect(reader, 5, tc.signal)

	// A higher offset still grows the range.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 7n, seqNo: 3n, data: bytes('c') }],
		})
	)
	await collect(reader, 1, tc.signal)

	// The commit request carries one grow-only range per partition: the equal/lower
	// redelivery neither rewound partition 10 nor bled into partition 20.
	await fake.commit()
	expect(txOffsetRequests).toHaveLength(1)
	let byPartition = new Map(
		txOffsetRequests[0]!.topics[0]!.partitions.map((p) => [p.partitionId, p.partitionOffsets])
	)
	expect(byPartition.get(10n)).toEqual([expect.objectContaining({ start: 5n, end: 8n })])
	expect(byPartition.get(20n)).toEqual([expect.objectContaining({ start: 100n, end: 101n })])
})

test('keeps the tx offset range monotonic when the server redelivers lower offsets after reconnect', async (tc) => {
	let { driver, waitForNextStream, txOffsetRequests } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using reader = new TopicReader(driver, { topic: '/t', consumer: 'c' }, { tx: fake.tx })

	let a = await primeStream(reader, waitForNextStream, 'session-A')
	a.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 5n })
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

	// Reconnect mid-tx: the tx has not committed offsets yet, so the server redelivers
	// from committedOffset 5 — and a realistic partial redelivery carries only offset 5.
	// A rewound lastOffset would make the tx commit under-commit and leak the tail to
	// the next transaction (cross-tx duplicates). (review BUG-TX-6)
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
			messages: [{ offset: 5n, seqNo: 1n, data: bytes('a') }],
		})
	)
	await collect(reader, 1, tc.signal)

	// The commit still covers [5, 7): the lower-only redelivery did not rewind the end.
	await fake.commit()
	expect(txOffsetRequests).toHaveLength(1)
	expect(txOffsetRequests[0]!.topics[0]!.partitions[0]!.partitionOffsets).toEqual([
		expect.objectContaining({ start: 5n, end: 7n }),
	])
})

// ── start handshake (async hook) ───────────────────────────────────────────────

test('re-sends a reconciled commit only after the start response on the new stream', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream1 = await primeStream(reader, waitForNextStream, 'session-A')
	stream1.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream1.waitForStartResponse()
	stream1.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	let messages = await collect(reader, 2, tc.signal)
	let commitPromise = reader.commit(messages)
	commitPromise.catch(() => {}) // settled later; avoid unhandled rejection on failure paths
	await stream1.waitForCommit()

	// The server never acks; the stream dies. The commit must survive the reconnect.
	stream1.disconnect()

	let stream2 = await waitForNextStream()
	await stream2.waitForInit()
	stream2.respond(initResponse('session-B'))
	await stream2.waitForReadRequest()
	stream2.respond(
		startPartitionSession({ partitionSessionId: 2n, partitionId: 10n, committedOffset: 0n })
	)
	let commit = await stream2.waitForCommit()
	expect(commit.commitOffsets[0]?.partitionSessionId).toBe(2n)

	// Wire ordering: the start response must precede the reconciled commit — a commit
	// for a not-yet-acknowledged session is session-fatal. (review wave-2)
	let startIdx = stream2.sent.findIndex(
		(m) => m.clientMessage.case === 'startPartitionSessionResponse'
	)
	let commitIdx = stream2.sent.findIndex((m) => m.clientMessage.case === 'commitOffsetRequest')
	expect(startIdx).toBeGreaterThanOrEqual(0)
	expect(commitIdx).toBeGreaterThanOrEqual(0)
	expect(startIdx).toBeLessThan(commitIdx)

	stream2.respond(commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 2n }]))
	await expect(commitPromise).resolves.toBeUndefined()
})

test('withholds the start response until the async hook resolves', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let hookGate = Promise.withResolvers<void>()
	await using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: async () => {
			await hookGate.promise
			return { readOffset: 5n }
		},
	})
	void reader // kept alive by `using`; the test drives the wire directly

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse('session-A'))
	await stream.waitForReadRequest()

	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, end: 10n }))
	// Give the machine time to (wrongly) answer early.
	await new Promise((resolve) => setTimeout(resolve, 20))
	expect(stream.sent.some((m) => m.clientMessage.case === 'startPartitionSessionResponse')).toBe(
		false
	)

	hookGate.resolve()
	let response = await stream.waitForStartResponse()
	expect(response.partitionSessionId).toBe(1n)
	expect(response.readOffset).toBe(5n)
})

test('ignores a hook that resolves after the reader is destroyed', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let hookGate = Promise.withResolvers<void>()
	let unhandled: unknown[] = []
	let onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)

	try {
		let reader = createTopicReader(driver, {
			topic: '/t',
			consumer: 'c',
			onPartitionSessionStart: async () => {
				await hookGate.promise
				return undefined
			},
		})

		let stream = await waitForNextStream()
		await stream.waitForInit()
		stream.respond(initResponse('session-A'))
		await stream.waitForReadRequest()
		stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
		await new Promise((resolve) => setTimeout(resolve, 10))

		reader.destroy()
		hookGate.resolve()
		await new Promise((resolve) => setTimeout(resolve, 25))

		expect(
			stream.sent.some((m) => m.clientMessage.case === 'startPartitionSessionResponse')
		).toBe(false)
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

test('keeps other partitions and destroy() working while a start hook hangs', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let hung = 0
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: (session: TopicPartitionSession) => {
			if (session.partitionId === 10n) {
				hung++
				return new Promise(() => {}) // never resolves
			}
			return Promise.resolve(undefined)
		},
	})

	let stream = await primeStream(reader, waitForNextStream, 'session-A')

	// partition 10's hook hangs; partition 20 must still complete its handshake.
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	stream.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 20n }))

	let ack = await stream.waitForStartResponse()
	expect(hung).toBe(1)
	expect(ack.partitionSessionId).toBe(2n) // only the non-hung partition answered

	// data + commit for partition 20 flow while partition 10 is stuck in its hook.
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
		})
	)
	let messages = await collect(reader, 1, tc.signal)
	let commitPromise = reader.commit(messages)
	await stream.waitForCommit()
	stream.respond(commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 1n }]))
	await commitPromise

	// destroy() is not blocked by the hung hook.
	reader.destroy(new Error('bye'))
	await settle()
	expect(stream.wasAborted()).toBe(true)
})

test('sends the start response without offsets when the hook throws and keeps reading', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: () => Promise.reject(new Error('offset store down')),
	})

	let stream = await primeStream(reader, waitForNextStream, 'session-A')
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 5n })
	)

	let ack = await stream.waitForStartResponse()
	expect(ack.partitionSessionId).toBe(1n)
	// no spurious 0 offsets — the server rejects read_offset below committed
	expect(ack.readOffset).toBeUndefined()
	expect(ack.commitOffset).toBeUndefined()

	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 5n, seqNo: 1n, data: bytes('ok') }],
		})
	)
	let messages = await collect(reader, 1, tc.signal)
	expect(messages).toHaveLength(1)
})

test('answers a re-granted partition exactly once when the previous stream hook finishes late', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let calls: PromiseWithResolvers<void>[] = []
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: () => {
			let d = Promise.withResolvers<void>()
			calls.push(d)
			return d.promise
		},
	})

	let stream1 = await primeStream(reader, waitForNextStream, 'session-A')
	stream1.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await settle()
	expect(calls).toHaveLength(1) // hook 1 running (slow)

	stream1.disconnect()

	let stream2 = await waitForNextStream()
	await stream2.waitForInit()
	stream2.respond(initResponse('session-B'))
	await stream2.waitForReadRequest()
	// Same partition, same per-stream session id 1 — the common case (server assign
	// ids restart at 1 per stream). Only the grant epoch tells the hooks apart; a
	// second StartPartitionSessionResponse for one assign id is session-fatal
	// ("double partition locking", BAD_REQUEST). (review wave-2)
	stream2.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await settle()
	expect(calls).toHaveLength(2) // hook 2 running

	// The STALE hook (stream 1) completes first, then the current one.
	calls[0]!.resolve()
	await settle()
	calls[1]!.resolve()
	await settle()

	let responses = stream2.sent.filter(
		(m) => m.clientMessage.case === 'startPartitionSessionResponse'
	)
	expect(responses).toHaveLength(1)
})

// ── flow control (release-before-yield) ────────────────────────────────────────

test('releases a chunk exactly once when limit splits it into several yields', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
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
				{ offset: 3n, seqNo: 4n, data: bytes('d') },
			],
			bytesSize: 500n,
		})
	)

	// One chunk of 4 messages, limit 2 → two slices. Break after the FIRST slice: the
	// credit must have been released once (before the first yield) — never per slice,
	// and never leaked by the break. (review M5 / READER-8)
	for await (let batch of reader.read({ limit: 2, signal: tc.signal })) {
		expect(batch.length).toBe(2)
		break
	}
	await settle()

	// initial full-buffer credit + exactly one 500n replenishment
	expect(readRequests(stream.sent)).toEqual([1000n, 500n])
})

test('releases consumed chunks when the signal aborts mid batch window', async () => {
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
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
			bytesSize: 400n,
		})
	)
	await settle()

	// Long window with limit unset: the chunk is consumed immediately, then read()
	// keeps waiting for more chunks. Abort during that wait — the abort throws out of
	// the accumulation, which must not strand the consumed chunk's credit. (M5 edge)
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
	// Let the loop consume the buffered chunk, then abort mid-window.
	await settle()
	ac.abort(new Error('consumer aborted'))
	await consume
	expect(String(thrown)).toContain('consumer aborted')
	await settle()

	// The consumed 400n chunk left the buffer — its credit must be returned.
	expect(readRequests(stream.sent)).toEqual([1000n, 400n])
})

test('keeps blocking past a fully filtered chunk until a delivered chunk arrives', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('stale') }],
			bytesSize: 100n,
		})
	)
	await settle()
	stream.respond(stopPartitionSession({ partitionSessionId: 1n, graceful: false }))
	stream.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 20n }))
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('live') }],
			bytesSize: 100n,
		})
	)
	await settle()

	// No batchWindowMs: read() must block for one DELIVERED chunk, i.e. skip past the
	// force-stopped partition's filtered chunk and yield the live partition's message
	// — never an empty batch. (review M7)
	for await (let batch of reader.read({ signal: tc.signal })) {
		expect(batch.length).toBe(1)
		expect(batch[0]!.partitionSession.deref()!.partitionId).toBe(20n)
		expect(text(batch[0]!.payload)).toBe('live')
		break
	}
})

// ── ended / stopping partitions still deliver ──────────────────────────────────

test('delivers buffered messages of an ended partition and commits them', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	await settle()
	// end_partition is informational (partition fully read) — buffered messages must
	// still be delivered and committable (isEnded, not isStopped). (review M7)
	stream.respond(endPartitionSession(1n))
	await settle()

	let delivered = await collect(reader, 2, tc.signal)
	expect(delivered.map((m) => m.offset)).toEqual([0n, 1n])

	let commitPromise = reader.commit(delivered)
	let commitRequest = await stream.waitForCommit()
	expect(commitRequest.commitOffsets.length).toBe(1)
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 2n }]))
	await expect(commitPromise).resolves.toBeUndefined()
})

test('delivers buffered messages while a graceful stop waits on pending commits', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)

	let first = await collect(reader, 1, tc.signal)
	let commitPromise = reader.commit(first)
	await stream.waitForCommit()

	// Graceful stop arrives while the commit is pending → 'stopping-graceful'. The
	// session is NOT stopped yet, so messages buffered behind the stop still deliver
	// — the delivery filter applies only once the stop completes. (review M7)
	stream.respond(
		stopPartitionSession({ partitionSessionId: 1n, graceful: true, committedOffset: 0n })
	)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 1n, seqNo: 2n, data: bytes('b') }],
		})
	)
	await settle()

	let second = await collect(reader, 1, tc.signal)
	expect(second.map((m) => m.offset)).toEqual([1n])

	// Drain the pending commit → the graceful stop completes with a stop response.
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	await expect(commitPromise).resolves.toBeUndefined()
	await settle()
	let stopAcks = stream.sent.filter(
		(m) => m.clientMessage.case === 'stopPartitionSessionResponse'
	)
	expect(stopAcks.length).toBe(1)
})

// ── update token ───────────────────────────────────────────────────────────────

test('sends a token refresh on the update interval', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		updateTokenIntervalMs: 20,
	})

	let stream = await primeStream(reader, waitForNextStream)

	// The interval timer is armed on init; the refresh carries the driver's token.
	let update = await stream.waitForUpdateToken()
	expect(update.token).toBe('fake-token')
})

test('keeps refreshing the token on the new stream after a reconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		updateTokenIntervalMs: 20,
	})

	let a = await primeStream(reader, waitForNextStream, 'session-A')
	await a.waitForUpdateToken()

	a.disconnect()

	// The reconnect re-arms the timer on the new session: the refresh must land on
	// stream B, not silently stop with the old stream.
	let b = await waitForNextStream()
	await b.waitForInit()
	b.respond(initResponse('session-B'))
	await b.waitForReadRequest()

	let update = await b.waitForUpdateToken()
	expect(update.token).toBe('fake-token')
})

test('coalesces update-token requests until one is acknowledged', async () => {
	// The token interval fires on a schedule with no inflight gate. If the stream is
	// open but the server never acks, un-coalesced pushes would pile token frames into
	// the stream queue indefinitely (a slow long-lived leak). With coalescing, at most
	// one un-acknowledged token is ever queued.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		updateTokenIntervalMs: 5, // fire many times quickly
	})

	let stream = await primeStream(reader, waitForNextStream)

	// Let the token interval fire many times without ever sending updateTokenResponse.
	await new Promise((resolve) => setTimeout(resolve, 60))

	let tokenFrames = () =>
		stream.sent.filter((m) => m.clientMessage.case === 'updateTokenRequest').length
	expect(tokenFrames()).toBe(1)

	// The ack clears the pending flag — the next tick sends a fresh refresh.
	stream.respond(updateTokenResponse())
	await expect.poll(tokenFrames, { timeout: 5000 }).toBeGreaterThanOrEqual(2)
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
