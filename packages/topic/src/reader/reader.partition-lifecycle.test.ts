import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { expect, test, vi } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { TopicReader, createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	makeFakeTopicDriver,
	readResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'

// Partition-lifecycle contract against the fake streamRead: the commit window while a
// graceful stop is outstanding, graceful→force escalation for one session, and the
// reassign-gc bound on commits orphaned by a force stop.

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

// Subscribe to an event channel and gather its payloads; `using` auto-unsubscribes.
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

type SentFrames = { clientMessage: { case?: string; value?: unknown } }[]

let commitFrames = function commitFrames(sent: SentFrames): number {
	return sent.filter((m) => m.clientMessage.case === 'commitOffsetRequest').length
}

let stopResponses = function stopResponses(sent: SentFrames): number {
	return sent.filter((m) => m.clientMessage.case === 'stopPartitionSessionResponse').length
}

// The protocol's soft stop holds the partition on the server until the client sends
// StopPartitionSessionResponse — the delay is the mechanism that lets the app finish
// processing and commit. onPartitionSessionStop is that last-chance window: it runs
// with the session still committable and is awaited (together with any commit it
// issues) before the stop response goes out.
test('commits delivered messages from onPartitionSessionStop before the graceful stop is answered', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let messages: TopicMessage[] = []
	let hookCommit: Promise<void> | undefined
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: () => {
			hookCommit = reader.commit(messages)
			hookCommit.catch(() => {}) // observed via assertions below; avoid an unhandled rejection
			return hookCommit
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
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
				{ offset: 2n, seqNo: 3n, data: bytes('c') },
				{ offset: 3n, seqNo: 4n, data: bytes('d') },
				{ offset: 4n, seqNo: 5n, data: bytes('e') },
			],
		})
	)
	messages.push(...(await collect(reader, 5, tc.signal)))

	// Soft stop with nothing in flight: the app gets its last-chance commit window.
	stream.respond(
		stopPartitionSession({ partitionSessionId: 1n, graceful: true, committedOffset: 0n })
	)
	await settle()

	expect(hookCommit).toBeDefined()
	// The last-chance commit must reach the wire — the window closes only with the
	// stop response, not with the stop request.
	expect(commitFrames(stream.sent)).toBe(1)
	expect(stopResponses(stream.sent)).toBe(0)

	// The server acks the commit → the callback finishes → the handoff completes.
	stream.respond(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 5n }]))
	await expect(hookCommit).resolves.toBeUndefined()
	await settle()
	expect(stopResponses(stream.sent)).toBe(1)
	let commitIdx = stream.sent.findIndex((m) => m.clientMessage.case === 'commitOffsetRequest')
	let stopIdx = stream.sent.findIndex(
		(m) => m.clientMessage.case === 'stopPartitionSessionResponse'
	)
	expect(commitIdx).toBeLessThan(stopIdx)
})

test('escalates a stalled graceful stop to force without answering either stop', async (tc) => {
	using stopped = capture<{ partitionId: bigint; reason: string }>(
		'ydb:topic.reader.partition.stopped'
	)
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let stopCalls = 0
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: () => {
			stopCalls++
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
			messages: [
				{ offset: 0n, seqNo: 1n, data: bytes('a') },
				{ offset: 1n, seqNo: 2n, data: bytes('b') },
			],
		})
	)
	let messages = await collect(reader, 2, tc.signal)

	// Two commits in flight: [0,1) and [1,2); the server acks neither yet.
	let covered = reader.commit(messages[0]!)
	await stream.waitForCommit()
	let held = reader.commit(messages[1]!)
	let heldSettled = false
	held.then(
		() => (heldSettled = true),
		() => (heldSettled = true)
	)
	await settle()
	expect(commitFrames(stream.sent)).toBe(2)

	// Graceful stop with commits pending → the reader withholds the stop response.
	// The stop hook fires right away (the soft-stop commit window), while the session
	// keeps draining.
	stream.respond(
		stopPartitionSession({ partitionSessionId: 1n, graceful: true, committedOffset: 0n })
	)
	await settle()
	expect(stopResponses(stream.sent)).toBe(0)
	expect(stopCalls).toBe(1)

	// The server escalates: a force stop for the same session, its committed mark
	// covering only the first commit.
	stream.respond(
		stopPartitionSession({ partitionSessionId: 1n, graceful: false, committedOffset: 1n })
	)
	await settle()

	// The covered commit resolves off the force stop's committed mark; a non-graceful
	// stop is never answered, and the superseded graceful stop must not be either.
	await expect(covered).resolves.toBeUndefined()
	expect(stopResponses(stream.sent)).toBe(0)

	// The app hears both phases: the soft-stop commit window, then the loss — inside
	// the callback they are distinguishable via session.isStopped (false during the
	// window, true once lost).
	expect(stopCalls).toBe(2)
	expect(stopped.payloads).toEqual([expect.objectContaining({ partitionId: 10n, reason: 'lost' })])

	// The uncovered commit is held for a possible re-grant, not settled by the stop.
	expect(heldSettled).toBe(false)

	// The reader keeps serving new grants after the double stop.
	stream.respond(startPartitionSession({ partitionSessionId: 2n, partitionId: 11n }))
	await settle()
	let acks = stream.sent.filter((m) => m.clientMessage.case === 'startPartitionSessionResponse')
	expect(acks).toHaveLength(2)
	expect(acks.at(-1)!.clientMessage.value.partitionSessionId).toBe(2n)
})

test('settles an orphaned in-flight commit via the reassign gc after a force stop', async (tc) => {
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

	let commit = reader.commit(message!)
	let settled = false
	commit.then(
		() => (settled = true),
		() => (settled = true)
	)
	await stream.waitForCommit()

	// The CommitOffsetResponse never arrives: the partition is force-stopped
	// (rebalanced away) with the server's committed mark below the in-flight range.
	// Fake timers let the test fire the gc bound without waiting out the real window.
	vi.useFakeTimers()
	try {
		stream.respond(
			stopPartitionSession({ partitionSessionId: 1n, graceful: false, committedOffset: 0n })
		)
		await settle()

		// The stop itself must not settle the commit — the offsets may still reconcile
		// if the partition comes back on this reader.
		expect(settled).toBe(false)

		// The partition never returns: the reassign gc must settle the waiter instead of
		// leaving the caller pending forever (the server silently drops commits for a
		// session it already revoked).
		vi.advanceTimersByTime(60_000)
		await settle()
		expect(settled).toBe(true)
	} finally {
		vi.useRealTimers()
	}

	await expect(commit).rejects.toThrow('reassigned before commit was acknowledged')
})
