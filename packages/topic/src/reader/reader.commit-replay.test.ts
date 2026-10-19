import { toBinary } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import {
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromClientSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { MessageSizeError, Server } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import type { TopicMessage } from '../message.ts'
import { createTopicReader } from './index.ts'
import {
	commitOffsetResponse,
	initResponse,
	readResponse,
	startPartitionSession,
} from './reader.fixtures.ts'

test.for([
	{ maxSendBytes: 1024, offsetBase: 0n, sessionBase: 0n },
	{ maxSendBytes: 64, offsetBase: (1n << 63n) - 401n, sessionBase: (1n << 63n) - 3n },
])('bounds sparse commit replay to $maxSendBytes bytes', async (settings, tc) => {
	let { maxSendBytes, offsetBase, sessionBase } = settings
	let requests: StreamReadMessage_FromClient[] = []
	let replayed: Array<{ start: bigint; end: bigint }> = []
	let gapCommits: Array<{ start: bigint; end: bigint }> = []
	let observed = Promise.withResolvers<void>()
	let replayComplete = Promise.withResolvers<void>()
	let streams = 0
	let originals = 0
	let acknowledged = 0
	let payload = new Uint8Array(1)
	let messages = Array.from({ length: 400 }, (_, index) => ({
		offset: offsetBase + BigInt(index),
		seqNo: BigInt(index + 1),
		data: payload,
	}))

	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input) {
			let stream = ++streams
			let partitionSessionId = sessionBase + BigInt(stream)
			for await (let message of input) {
				let request = message.clientMessage
				if (request.case === 'initRequest') {
					yield initResponse(`session-${stream}`)
					yield startPartitionSession({
						partitionSessionId,
						partitionId: 10n,
						committedOffset: offsetBase,
						start: offsetBase,
						end: offsetBase + 400n,
					})
				}
				if (request.case === 'startPartitionSessionResponse' && stream === 1) {
					yield readResponse({ partitionSessionId, messages })
				}
				if (request.case !== 'commitOffsetRequest') continue
				requests.push(message)
				if (stream === 1) {
					originals++
					observed.resolve()
					if (originals === 200) return
					continue
				}

				let offsets = request.value.commitOffsets[0]!.offsets
				if (replayed.length < 200) {
					replayed.push(...offsets)
					if (replayed.length === 200) replayComplete.resolve()
				} else {
					gapCommits.push(...offsets)
					if (gapCommits.length === 200) {
						yield commitOffsetResponse([
							{ partitionSessionId, committedOffset: offsetBase + 400n },
						])
					}
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		transportOptions: { maxSendBytes },
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let delivered: TopicMessage[] = []
	for await (let batch of reader.read({ signal: tc.signal })) {
		delivered.push(...batch)
		if (delivered.length === messages.length) break
	}

	let pending: Promise<void>[] = []
	for (let message of delivered.filter((_, index) => index % 2 === 1)) {
		let commit = reader.commit(message)
		void commit.then(
			() => acknowledged++,
			() => {}
		)
		pending.push(commit)
		// Each original request fits; only reconnect combines the pending sparse ranges.
		// oxlint-disable-next-line no-await-in-loop
		await abortable(tc.signal, observed.promise)
		observed = Promise.withResolvers<void>()
	}
	let allCommitted = Promise.all(pending)
	await Promise.race([allCommitted, abortable(tc.signal, replayComplete.promise)])

	let replayOffsets = replayed.map(({ start, end }) => ({ start, end }))
	let expectedReplay = messages
		.filter((_, index) => index % 2 === 1)
		.map(({ offset }) => ({ start: offset, end: offset + 1n }))
	expect(replayOffsets).toEqual(expectedReplay)
	expect(acknowledged).toBe(0)
	expect(streams).toBe(2)

	let gaps = delivered.filter((_, index) => index % 2 === 0)
	await reader.commit(gaps)
	await allCommitted
	let gapOffsets = gapCommits.map(({ start, end }) => ({ start, end }))
	let expectedGaps = messages
		.filter((_, index) => index % 2 === 0)
		.map(({ offset }) => ({ start: offset, end: offset + 1n }))
	let requestSizes = requests.map(
		(message) => toBinary(StreamReadMessage_FromClientSchema, message).byteLength
	)
	expect(gapOffsets).toEqual(expectedGaps)
	expect(acknowledged).toBe(200)
	expect(Math.max(...requestSizes)).toBeLessThanOrEqual(maxSendBytes)
})

test('rejects a single commit range that exceeds the transport limit', async (tc) => {
	let maxSendBytes = 16
	let offset = (1n << 63n) - 2n
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(input) {
			for await (let { clientMessage: request } of input) {
				if (request.case === 'initRequest') {
					yield initResponse()
					yield startPartitionSession({ partitionSessionId: 1n, partitionId: 10n })
				}
				if (request.case === 'startPartitionSessionResponse') {
					yield readResponse({
						partitionSessionId: 1n,
						messages: [{ offset, seqNo: 1n, data: new Uint8Array(1) }],
					})
				}
			}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		transportOptions: { maxSendBytes },
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let messages = reader.read({ signal: tc.signal })[Symbol.asyncIterator]()
	let batch = await messages.next()
	if (batch.done) throw new Error('Reader ended before delivering the message')
	let commit = reader.commit(batch.value[0]!)
	await expect(commit).rejects.toEqual(new MessageSizeError('request', maxSendBytes))
	await messages.return?.()
})
