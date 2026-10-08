import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { StreamReadMessage_FromServer } from '@ydbjs/api/topic'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	makeFakeTopicDriver,
	readResponse,
	settle,
	startPartitionSession,
} from './reader.fixtures.ts'

// Autopartitioning split flow over the wire: the InitRequest opt-in flag, and the
// endPartitionSession contract — the ended parent stays committable (its session is
// only released by the server's stop), the child partition ids surface on the parent
// session, and the children's fresh grants deliver independently. The parent-commit-
// before-child-read ORDERING is enforced server-side; the client's duty is to keep
// both legs working. Merge is not implemented server-side yet — split only.

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

let text = function text(payload: Uint8Array): string {
	return new TextDecoder().decode(payload)
}

// Drive the shared read() iterator until `count` messages accumulate (idle ticks
// yield empty batches and are skipped). `signal` bounds a hang.
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

// Like collect, but bounded: gives up after 20 consecutive empty batch windows
// so a never-delivered message surfaces as a short result, not a hang.
let collectUpTo = async function collectUpTo(
	reader: ReturnType<typeof createTopicReader>,
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

// endPartitionSession is the server's split notice ("partition fully read") — not in
// the shared fixtures because only these tests exercise the child/adjacent ids.
let endPartitionSession = function endPartitionSession(params: {
	partitionSessionId: bigint
	childPartitionIds?: bigint[]
	adjacentPartitionIds?: bigint[]
}): StreamReadMessage_FromServer {
	return {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'endPartitionSession',
			value: {
				partitionSessionId: params.partitionSessionId,
				childPartitionIds: params.childPartitionIds ?? [],
				adjacentPartitionIds: params.adjacentPartitionIds ?? [],
			},
		},
	} as unknown as StreamReadMessage_FromServer
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

// The server only sends endPartitionSession (and keeps a split parent assigned until
// its offsets are committed) when the reader opted in — the flag must reach the wire,
// and must stay off by default because an opted-in reader that ignores child ids
// would strand split partitions.
test('declares autopartitioning support in the init request', async () => {
	let supporting = makeFakeTopicDriver()
	using reader = createTopicReader(supporting.driver, {
		topic: '/t',
		consumer: 'c',
		autoPartitioningSupport: true,
	})
	void reader // kept alive by `using`; the test drives the wire directly

	let stream = await supporting.waitForNextStream()
	let init = await stream.waitForInit()
	expect(init.autoPartitioningSupport).toBe(true)

	let plain = makeFakeTopicDriver()
	using defaultReader = createTopicReader(plain.driver, { topic: '/t', consumer: 'c' })
	void defaultReader

	let defaultStream = await plain.waitForNextStream()
	let defaultInit = await defaultStream.waitForInit()
	expect(defaultInit.autoPartitioningSupport).toBe(false)
})

// After a split the server holds the children back until the parent's offsets are
// committed — a parent whose session became uncommittable at endPartitionSession
// would deadlock the topic. The commit must go out under the parent's session id
// and resolve on the ack, and the split metadata must be visible on the session.
test('keeps a split parent committable until its offsets are acked', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		autoPartitioningSupport: true,
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, committedOffset: 0n })
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

	stream.respond(endPartitionSession({ partitionSessionId: 1n, childPartitionIds: [1n, 2n] }))
	await settle()

	let session = messages[0]!.partitionSession.deref()
	expect(session?.isEnded).toBe(true)
	expect(session?.childPartitionIds).toEqual([1n, 2n])

	let commit = reader.commit(messages)
	commit.catch(() => {}) // settled below on the ack; avoid an unhandled rejection on teardown

	let request = await stream.waitForCommit()
	expect(request.commitOffsets).toHaveLength(1)
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(1n)
	expect(request.commitOffsets[0]!.offsets[0]!.start).toBe(0n)
	expect(request.commitOffsets[0]!.offsets[0]!.end).toBe(3n)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 3n }]))
	await expect(commit).resolves.toBeUndefined()
})

// Child partitions arrive as ordinary fresh grants on the same stream while the
// ended parent's entry is still registered — the registry keyed by (path, partition)
// must hold all three without the children's data misrouting or being dropped.
test('reads split children alongside the ended parent', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		autoPartitioningSupport: true,
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('parent') }],
		})
	)
	let parentMessages = await collect(reader, 1, tc.signal)
	expect(parentMessages.map((m) => text(m.payload))).toEqual(['parent'])
	expect(parentMessages[0]!.partitionSession.deref()?.partitionId).toBe(0n)

	stream.respond(endPartitionSession({ partitionSessionId: 1n, childPartitionIds: [1n, 2n] }))
	await settle()

	stream.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 1n }))
	await waitForStartAck(stream, 2n)
	stream.respond(startPartitionSession({ partitionSessionId: 3n, partitionId: 2n }))
	await waitForStartAck(stream, 3n)

	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('child-1') }],
		})
	)
	stream.respond(
		readResponse({
			partitionSessionId: 3n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('child-2') }],
		})
	)

	let childMessages = await collectUpTo(reader, 2, tc.signal)
	let byPartition = childMessages
		.map((m) => ({
			partitionId: m.partitionSession.deref()?.partitionId,
			topicPath: m.partitionSession.deref()?.topicPath,
			payload: text(m.payload),
		}))
		.sort((a, b) => Number(a.partitionId! - b.partitionId!))
	expect(byPartition).toEqual([
		{ partitionId: 1n, topicPath: '/t', payload: 'child-1' },
		{ partitionId: 2n, topicPath: '/t', payload: 'child-2' },
	])
})

// The server guarantees parent-before-child ordering by holding the child grants;
// once it decides to grant them, the client must serve both legs concurrently — an
// in-flight parent commit must not gate child delivery, and the child grant must
// not disturb the parent's pending commit.
test('delivers child data granted before the parent commit is acked', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		autoPartitioningSupport: true,
	})

	let stream = await primeStream(reader, waitForNextStream)
	stream.respond(
		startPartitionSession({ partitionSessionId: 1n, partitionId: 0n, committedOffset: 0n })
	)
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('parent') }],
		})
	)
	let [parentMessage] = await collect(reader, 1, tc.signal)

	stream.respond(endPartitionSession({ partitionSessionId: 1n, childPartitionIds: [1n] }))
	await settle()

	let commit = reader.commit(parentMessage!)
	commit.catch(() => {}) // settled below on the ack; avoid an unhandled rejection on teardown
	let request = await stream.waitForCommit()
	expect(request.commitOffsets[0]!.partitionSessionId).toBe(1n)

	// Child granted and delivering while the parent's commit is still un-acked.
	stream.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 1n }))
	await waitForStartAck(stream, 2n)
	stream.respond(
		readResponse({
			partitionSessionId: 2n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('child') }],
		})
	)
	let childMessages = await collectUpTo(reader, 1, tc.signal)
	expect(childMessages.map((m) => text(m.payload))).toEqual(['child'])
	expect(childMessages[0]!.partitionSession.deref()?.partitionId).toBe(1n)

	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }]))
	await expect(commit).resolves.toBeUndefined()
})
