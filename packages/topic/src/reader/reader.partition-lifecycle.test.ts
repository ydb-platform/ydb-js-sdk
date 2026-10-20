import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { abortable } from '@ydbjs/abortable'
import {
	type StreamReadMessage_FromClient,
	type StreamReadMessage_FromServer,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { AsyncQueue } from '@ydbjs/fsm/queue'

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
	waitForNextStream: ReturnType<typeof makeFakeTopicDriver>['waitForNextStream'],
	sessionId = 'session-A'
) {
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(sessionId))
	await stream.waitForReadRequest()
	return stream
}

test('keeps registered callbacks after the caller mutates its options', async (tc) => {
	let calls: string[] = []
	let stopped = Promise.withResolvers<void>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests) {
			for await (let { clientMessage } of requests) {
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
					})
				}
				if (clientMessage.case === 'commitOffsetRequest') {
					yield commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 1n }])
					yield stopPartitionSession({
						partitionSessionId: 1n,
						graceful: false,
						committedOffset: 1n,
					})
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let options = {
		topic: '/t',
		consumer: 'c',
		onCommittedOffset: () => {
			calls.push('registered-commit')
		},
		onPartitionSessionStop: async () => {
			calls.push('registered-stop')
			stopped.resolve()
		},
	}
	using reader = createTopicReader(driver, options)
	options.onCommittedOffset = () => {
		calls.push('replacement-commit')
	}
	options.onPartitionSessionStop = async () => {
		calls.push('replacement-stop')
		stopped.resolve()
	}
	let messages = await collect(reader, 1, tc.signal)
	await reader.commit(messages)
	await stopped.promise
	expect(calls).toEqual(['registered-commit', 'registered-stop'])
})

test('commits delivered messages from onPartitionSessionStop before the graceful stop is answered', async (tc) => {
	let commitReceived = Promise.withResolvers<void>()
	let probeReceived = Promise.withResolvers<void>()
	let stopAnswered = Promise.withResolvers<void>()
	let requestsFinished = Promise.withResolvers<void>()
	let sent: StreamReadMessage_FromClient[] = []
	let stopAfterAcknowledgment: boolean[] = []
	let acknowledged = false
	using responses = new AsyncQueue<StreamReadMessage_FromServer>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		streamRead(requests) {
			let receiving = (async () => {
				try {
					for await (let frame of requests) {
						sent.push(frame)
						let { clientMessage } = frame
						if (clientMessage.case === 'initRequest') {
							responses.push(initResponse())
							responses.push(
								startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
							)
						}
						if (clientMessage.case === 'startPartitionSessionResponse') {
							if (clientMessage.value.partitionSessionId === 1n) {
								responses.push(
									readResponse({
										partitionSessionId: 1n,
										messages: [0n, 1n, 2n, 3n, 4n].map((offset) => ({
											offset,
											seqNo: offset + 1n,
											data: bytes(String(offset)),
										})),
									})
								)
							} else probeReceived.resolve()
						}
						if (clientMessage.case === 'commitOffsetRequest') commitReceived.resolve()
						if (clientMessage.case === 'stopPartitionSessionResponse') {
							stopAfterAcknowledgment.push(acknowledged)
							stopAnswered.resolve()
						}
					}
				} finally {
					requestsFinished.resolve()
				}
			})()
			void receiving.catch((error: unknown) => responses.fail(error))
			return responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let messages: TopicMessage[] = []
	let hookCommit: Promise<void> | undefined
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: async () => {
			hookCommit = reader.commit(messages)
			return hookCommit
		},
	})
	messages.push(...(await collect(reader, 5, tc.signal)))
	responses.push(
		stopPartitionSession({ partitionSessionId: 1n, graceful: true, committedOffset: 0n })
	)
	await commitReceived.promise
	// A later request on the same stream exposes any stop already sent before the commit ACK.
	responses.push(startPartitionSession({ partitionSessionId: 2n, partitionId: 11n }))
	await probeReceived.promise
	let commitCount = sent.filter(
		(frame) => frame.clientMessage.case === 'commitOffsetRequest'
	).length
	expect(commitCount).toBe(1)
	expect(hookCommit).toBeDefined()
	expect(stopAfterAcknowledgment).toEqual([])
	acknowledged = true
	responses.push(commitOffsetResponse([{ partitionSessionId: 1n, committedOffset: 5n }]))
	await expect(hookCommit).resolves.toBeUndefined()
	await stopAnswered.promise
	await reader.close()
	await requestsFinished.promise
	expect(stopAfterAcknowledgment).toEqual([true])
	let commitIndex = sent.findIndex((frame) => frame.clientMessage.case === 'commitOffsetRequest')
	let stopIndex = sent.findIndex(
		(frame) => frame.clientMessage.case === 'stopPartitionSessionResponse'
	)
	expect(commitIndex).toBeLessThan(stopIndex)
})

test('escalates a stalled graceful stop to force without answering either stop', async (tc) => {
	using stopped = capture<{ partitionId: bigint; reason: string }>(
		'ydb:topic.reader.partition.stopped'
	)
	let forceStop = Promise.withResolvers<void>()
	let newGrant = Promise.withResolvers<void>()
	let sent: StreamReadMessage_FromClient[] = []
	let commits = 0
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(requests, context) {
			for await (let frame of requests) {
				sent.push(frame)
				let { clientMessage } = frame
				if (clientMessage.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (clientMessage.case === 'startPartitionSessionResponse') {
					if (clientMessage.value.partitionSessionId === 1n) {
						yield readResponse({
							partitionSessionId: 1n,
							messages: [0n, 1n].map((offset) => ({
								offset,
								seqNo: offset + 1n,
								data: bytes(String(offset)),
							})),
						})
					} else newGrant.resolve()
				}
				if (clientMessage.case === 'commitOffsetRequest' && ++commits === 2) {
					yield stopPartitionSession({
						partitionSessionId: 1n,
						graceful: true,
						committedOffset: 0n,
					})
					await abortable(context.signal, forceStop.promise)
					yield stopPartitionSession({
						partitionSessionId: 1n,
						graceful: false,
						committedOffset: 1n,
					})
					yield startPartitionSession({ partitionSessionId: 2n, partitionId: 11n })
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let stopCalls = 0
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStop: async () => {
			stopCalls++
		},
	})
	let messages = await collect(reader, 2, tc.signal)
	let covered = reader.commit(messages[0]!)
	await expect.poll(() => commits).toBe(1)
	let held = reader.commit(messages[1]!)
	let heldSettled = false
	void held.then(
		() => (heldSettled = true),
		() => (heldSettled = true)
	)
	await expect.poll(() => commits).toBe(2)
	await expect.poll(() => stopCalls).toBe(1)
	let stopResponses = () =>
		sent.filter((frame) => frame.clientMessage.case === 'stopPartitionSessionResponse')
	expect(stopResponses()).toHaveLength(0)
	forceStop.resolve()
	await expect(covered).resolves.toBeUndefined()
	await newGrant.promise
	expect(stopResponses()).toHaveLength(0)
	expect(stopCalls).toBe(2)
	expect(stopped.payloads).toEqual([
		expect.objectContaining({ partitionId: 10n, reason: 'lost' }),
	])
	expect(heldSettled).toBe(false)
	let starts = sent.flatMap(({ clientMessage }) =>
		clientMessage.case === 'startPartitionSessionResponse' ? [clientMessage.value] : []
	)
	expect(starts).toHaveLength(2)
	expect(starts.at(-1)!.partitionSessionId).toBe(2n)
})

// Fake timers select the orphan-GC deadline without running HTTP/2 timers under the same clock.
test('settles an orphaned in-flight commit via the reassign gc after a force stop', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })

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
