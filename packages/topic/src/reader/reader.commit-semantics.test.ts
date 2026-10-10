import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { StreamReadMessage_FromServer } from '@ydbjs/api/topic'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { createTopicReader } from './index.ts'
import type { FakeReadStream } from './reader.fixtures.ts'
import {
	commitOffsetResponse,
	initResponse,
	makeFakeTopicDriver,
	partitionStatusResponse,
	readResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'

// Commit semantics over the wire: which offset ranges commit() actually sends, how the
// gap-fill anchor distinguishes retention holes from delivered-but-unacked messages,
// what a sparse or foreign-reader commit does, and when onCommittedOffset fires.

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

// Drive the shared read() iterator until `count` messages accumulate (idle ticks yield
// empty batches and are skipped). `signal` bounds a hang if the count never arrives.
let collect = async function collect(
	reader: ReturnType<typeof createTopicReader>,
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
// fixtures because only a few tests exercise it.
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

// Every CommitOffsetRequest the reader put on this stream, in send order.
let commitRequests = function commitRequests(stream: FakeReadStream) {
	return stream.sent.flatMap((m) =>
		m.clientMessage.case === 'commitOffsetRequest' ? [m.clientMessage.value] : []
	)
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

test('batches per-message commits from one turn behind one promise and one wire request', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()

	let count = 1000
	let source = Array.from({ length: count }, (_, offset) => ({
		offset: BigInt(offset),
		seqNo: BigInt(offset + 1),
		data: bytes(String(offset)),
	}))
	stream.respond(readResponse({ partitionSessionId: 1n, messages: source }))
	let messages = await collect(reader, count, tc.signal)

	let promises: Promise<void>[] = []
	for (let message of messages) {
		promises.push(reader.commit(message))
	}

	// Promise identity is the allocation contract: all synchronous calls join the
	// same microtask batch instead of allocating one public promise per message.
	expect(new Set(promises).size).toBe(1)

	let request = await stream.waitForCommit()
	expect(request.commitOffsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.offsets).toMatchObject([{ start: 0n, end: BigInt(count) }])
	await settle()
	expect(commitRequests(stream)).toHaveLength(1)

	stream.respond(
		commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: BigInt(count) }])
	)
	await expect(Promise.all(promises)).resolves.toHaveLength(count)
})

test('merges message and array commit inputs into the same microtask batch', async (tc) => {
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
				{ offset: 2n, seqNo: 3n, data: bytes('c') },
			],
		})
	)
	let messages = await collect(reader, 3, tc.signal)

	let first = reader.commit(messages[0]!)
	let rest = reader.commit(messages.slice(1))
	expect(first).toBe(rest)

	let request = await stream.waitForCommit()
	expect(request.commitOffsets[0]!.offsets).toMatchObject([{ start: 0n, end: 3n }])
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 3n }]))
	await expect(first).resolves.toBeUndefined()
})

test('keeps separate microtask batches pending behind the same server watermark', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 5n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: Array.from({ length: 7 }, (_, index) => ({
				offset: BigInt(index + 5),
				seqNo: BigInt(index + 1),
				data: bytes(String(index)),
			})),
		})
	)
	let messages = await collect(reader, 7, tc.signal)

	let first = reader.commit(messages.slice(0, 5))
	let firstRequest = await stream.waitForCommit()
	expect(firstRequest.commitOffsets[0]!.offsets).toMatchObject([{ start: 5n, end: 10n }])

	let second = reader.commit(messages.slice(2))
	expect(second).not.toBe(first)
	await settle()
	let requests = commitRequests(stream)
	expect(requests).toHaveLength(2)
	expect(requests[1]!.commitOffsets[0]!.offsets).toMatchObject([{ start: 10n, end: 12n }])

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 12n }]))
	await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
})

test('keeps a duplicate from a later microtask pending without sending it twice', async (tc) => {
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
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
		})
	)
	let [message] = await collect(reader, 1, tc.signal)

	let first = reader.commit(message!)
	await stream.waitForCommit()
	let duplicate = reader.commit(message!)
	let duplicateSettled = false
	void duplicate.then(
		() => {
			duplicateSettled = true
			return undefined
		},
		() => undefined
	)
	await settle()

	expect(commitRequests(stream)).toHaveLength(1)
	expect(duplicateSettled).toBe(false)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined])
})

// ── stitched commit ranges ──────────────────────────────────────────────────────

// Each message acknowledges only its own stitched range: with all earlier offsets
// delivered and no server-side hole, commit(msg4) covers exactly [4, 5). Gap-fill
// exists for retention holes, never for delivered-but-unacked messages — the server
// commits gap-free ACKED intervals only, and a message deliberately left uncommitted
// (e.g. a failed handler in concurrent per-message processing) must be redelivered.
test('commits only the acked message when earlier delivered messages are unacked', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()
	// Contiguous delivery from the committed offset: every offset exists, none acked.
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
				{ offset: 2n, seqNo: 3n, data: bytes('c') },
				{ offset: 3n, seqNo: 4n, data: bytes('d') },
				{ offset: 4n, seqNo: 5n, data: bytes('e') },
			],
		})
	)
	let messages = await collect(reader, 5, tc.signal)

	let commit = reader.commit(messages[4]!)
	commit.catch(() => {})

	let request = await stream.waitForCommit()
	expect(request.commitOffsets[0]!.offsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.offsets[0]!.start).toBe(4n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(5n)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 5n }]))
	await expect(commit).resolves.toBeUndefined()
})

test('commits live partitions when the same batch contains a stopped partition', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 0n })
	)
	stream.respond(
		startPartitionSession({ partitionSessionId: 2n, partitionId: 20n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()
	await settle(10)
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('stopped') }],
		})
	)
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('live') }],
		})
	)
	let messages = await collect(reader, 2, tc.signal)

	stream.respond(
		stopPartitionSession({ partitionSessionId: 1n, graceful: false, committedOffset: 0n })
	)
	await settle(10)

	let commit = reader.commit(messages)
	commit.catch(() => {})
	let request = await stream.waitForCommit()
	expect(request.commitOffsets).toEqual([
		expect.objectContaining({
			partitionSessionId: 2n,
			offsets: [expect.objectContaining({ start: 0n, end: 1n })],
		}),
	])

	stream.respond(commitOffsetResponse([{ partitionSessionId: 2n, committedOffset: 1n }]))
	await expect(commit).rejects.toThrow(/stopped or expired partition session/)
	expect(commitRequests(stream)).toHaveLength(1)
})

test('gap-fills the first commit range from the server committed offset across a retention hole', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	// Retention deleted offsets 2..4: the server reports committedOffset 2 and the
	// first message that still exists is offset 5. The offsets in the hole were never
	// delivered, so committing msg5 must cover [2, 6) — otherwise the consumer's
	// committed offset could never advance past the hole.
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 2n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 5n, seqNo: 1n, data: bytes('a') },
				{ offset: 6n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	let messages = await collect(reader, 2, tc.signal)

	let commit = reader.commit(messages[0]!)
	let request = await stream.waitForCommit()
	expect(request.commitOffsets[0]!.offsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.offsets[0]!.start).toBe(2n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(6n)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 6n }]))
	await expect(commit).resolves.toBeUndefined()
})

// ── sparse commit in a single call ─────────────────────────────────────────────

// The server treats the commit ack as a watermark: a committed range above an
// uncommitted gap is held back until the gap is committed. A single commit() with
// non-contiguous messages sends exactly its disjoint ranges; a later commit of the
// gap offsets reaches the wire too, the watermark advances over the now-contiguous
// coverage, and both promises resolve.
test('sends the gap offsets to the wire so a sparse commit() can resolve', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 5n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [
				{ offset: 5n, seqNo: 1n, data: bytes('a') },
				{ offset: 6n, seqNo: 2n, data: bytes('b') },
				{ offset: 7n, seqNo: 3n, data: bytes('c') },
				{ offset: 8n, seqNo: 4n, data: bytes('d') },
				{ offset: 9n, seqNo: 5n, data: bytes('e') },
			],
		})
	)
	let messages = await collect(reader, 5, tc.signal)

	let sparse = reader.commit([messages[0]!, messages[4]!])
	sparse.catch(() => {})
	let first = await stream.waitForCommit()
	expect(first.commitOffsets[0]!.offsets.map((r) => [r.start, r.end])).toEqual([
		[5n, 6n],
		[9n, 10n],
	])

	// The watermark can only advance up to the gap.
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 6n }]))
	await settle()

	// Committing the gap offsets must produce a second CommitOffsetRequest covering
	// 6..8 — without it the server watermark (and the sparse commit) is stuck forever.
	let gap = reader.commit([messages[1]!, messages[2]!, messages[3]!])
	gap.catch(() => {})
	await settle()
	expect(commitRequests(stream)).toHaveLength(2)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 10n }]))
	await expect(gap).resolves.toBeUndefined()
	await expect(sparse).resolves.toBeUndefined()
})

// ── foreign-reader messages ────────────────────────────────────────────────────

// commit() verifies the message's partition session belongs to THIS reader: a
// message from a different reader (different consumer) is rejected and nothing goes
// on the wire — committing it here would corrupt both consumers' progress.
test('rejects a commit of a message owned by a different reader', async (tc) => {
	let a = makeFakeTopicDriver()
	let b = makeFakeTopicDriver()
	using readerA = createTopicReader(a.driver, { topic: '/t', consumer: 'consumer-a' })
	using readerB = createTopicReader(b.driver, { topic: '/t', consumer: 'consumer-b' })

	let streamA = await primeStream(readerA, a.waitForNextStream)
	streamA.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, committedOffset: 0n })
	)
	await streamA.waitForStartResponse()

	let streamB = await primeStream(readerB, b.waitForNextStream)
	streamB.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, committedOffset: 0n })
	)
	await streamB.waitForStartResponse()
	streamB.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('b') }],
		})
	)
	let [foreign] = await collect(readerB, 1, tc.signal)

	let commit = readerA.commit(foreign!)
	commit.catch(() => {})
	await settle()
	expect(commitRequests(streamA)).toHaveLength(0)
	await expect(commit).rejects.toThrow(/partition session/)
})

test('rejects a foreign-reader commit whose partition is not granted locally', async (tc) => {
	let a = makeFakeTopicDriver()
	let b = makeFakeTopicDriver()
	using readerA = createTopicReader(a.driver, { topic: '/t', consumer: 'consumer-a' })
	using readerB = createTopicReader(b.driver, { topic: '/t', consumer: 'consumer-b' })

	let streamA = await primeStream(readerA, a.waitForNextStream)
	streamA.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, committedOffset: 0n })
	)
	await streamA.waitForStartResponse()

	// Reader B holds partition 5, which reader A was never granted.
	let streamB = await primeStream(readerB, b.waitForNextStream)
	streamB.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 5n, committedOffset: 0n })
	)
	await streamB.waitForStartResponse()
	streamB.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('b') }],
		})
	)
	let [foreign] = await collect(readerB, 1, tc.signal)

	// The commit must fail rather than hang or land on the wrong consumer, and the
	// reader must not send anything for a partition it does not own.
	await expect(readerA.commit(foreign!)).rejects.toThrow(/partition/)
	expect(commitRequests(streamA)).toHaveLength(0)
})

// ── onCommittedOffset observer ─────────────────────────────────────────────────

test('reports a start-session commitOffset after server status confirms it', async () => {
	let acks: bigint[] = []
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: async () => ({ commitOffset: 10n }),
		onCommittedOffset: (_, committedOffset) => {
			acks.push(committedOffset)
		},
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 10n, committedOffset: 5n })
	)
	let response = await stream.waitForStartResponse()
	expect(response.commitOffset).toBe(10n)
	await settle()
	expect(acks).toEqual([])
	stream.respond(partitionStatusResponse(1n, 10n))
	await settle()
	expect(acks).toEqual([10n])
})

// A live server cannot deterministically lose a particular commit ack and then
// delay a start override's persistence; the scripted stream fixes both races.
test('keeps a reconnected commit pending until the start override is confirmed', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let starts = 0
	let confirmed: bigint[] = []
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: async () =>
			++starts > 1 ? { readOffset: 1n, commitOffset: 1n } : undefined,
		onCommittedOffset: (_, offset) => {
			confirmed.push(offset)
		},
	})
	let first = await primeStream(reader, waitForNextStream)
	first.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await first.waitForStartResponse()
	first.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('x') }],
		})
	)
	let [message] = await collect(reader, 1, tc.signal)
	let pending = reader.commit(message!)
	let resolved = false
	void pending.then(
		() => (resolved = true),
		() => undefined
	)
	await first.waitForCommit()
	first.disconnect()
	let second = await primeStream(reader, waitForNextStream)
	second.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await second.waitForStartResponse()
	await settle()
	expect(resolved).toBe(false)
	expect(confirmed).toEqual([])
	expect(second.sent.filter((m) => m.clientMessage.case === 'commitOffsetRequest')).toHaveLength(
		0
	)
	second.respond(partitionStatusResponse(1n, 0n))
	await expect
		.poll(
			() =>
				second.sent.filter((m) => m.clientMessage.case === 'partitionSessionStatusRequest')
					.length,
			{ timeout: 3000 }
		)
		.toBe(2)
	expect(resolved).toBe(false)
	second.respond(partitionStatusResponse(1n, 1n))
	await expect(pending).resolves.toBeUndefined()
	expect(confirmed).toEqual([1n])
})

// end_partition is informational: the session stays committable and the final
// commit's ack still arrives on the stream. The observer fires for every server
// commit acknowledgement, including the final one after end_partition — a consumer
// tracking offsets externally needs the last ack too.
test('invokes onCommittedOffset for a commit acked after end_partition', async (tc) => {
	let acks: Array<{ partitionId: bigint; committedOffset: bigint }> = []
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onCommittedOffset: (session, committedOffset) => {
			acks.push({ partitionId: session.partitionId, committedOffset })
		},
	})

	let stream = await primeStream(reader, waitForNextStream)
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
	let [message] = await collect(reader, 1, tc.signal)

	// The partition is fully read (split/merge) — but the last message is still
	// uncommitted, and the protocol accepts its commit until the server stops the
	// session.
	stream.respond(endPartitionSession(1n))
	await settle()

	let commit = reader.commit(message!)
	commit.catch(() => {})
	let request = await stream.waitForCommit()
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(1n)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	await expect(commit).resolves.toBeUndefined()

	expect(acks).toEqual([{ partitionId: 10n, committedOffset: 1n }])
})

// A stop request carries the server's committed watermark: the advance resolves the
// pending commits it covers and reports through onCommittedOffset exactly like a
// commit ack does.
test('invokes onCommittedOffset when a partition stop carries the committed watermark', async (tc) => {
	let acks: Array<{ partitionId: bigint; committedOffset: bigint }> = []
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onCommittedOffset: (session, committedOffset) => {
			acks.push({ partitionId: session.partitionId, committedOffset })
		},
	})

	let stream = await primeStream(reader, waitForNextStream)
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
	let [message] = await collect(reader, 1, tc.signal)

	let commit = reader.commit(message!)
	commit.catch(() => {})
	await stream.waitForCommit()

	// The ack raced a rebalance: the commit was applied server-side and its result
	// arrives as the stop's committed_offset instead of a commit_response.
	stream.respond(
		stopPartitionSession({ partitionSessionId: 1n, graceful: false, committedOffset: 1n })
	)
	await expect(commit).resolves.toBeUndefined()

	expect(acks).toEqual([{ partitionId: 10n, committedOffset: 1n }])
})

test('handles a rejected async commit observer without delaying commit', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let observer = Promise.withResolvers<void>()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onCommittedOffset: async () => {
			await observer.promise
			throw new Error('Asynchronous commit observer failed')
		},
	})
	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('message') }],
		})
	)
	let messages = await collect(reader, 1, tc.signal)
	let committed = reader.commit(messages)
	await stream.waitForCommit()
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	await expect(committed).resolves.toBeUndefined()
	observer.resolve()
	await new Promise<void>((resolve) => setImmediate(resolve))
	await expect(reader.close()).resolves.toBeUndefined()
})
