import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromClientSchema,
	type StreamReadMessage_FromServer,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { AsyncPriorityQueue } from '@ydbjs/fsm/queue'

import { createTopicWriter } from '../src/writer/index.js'

// Real-YDB protocol truth for the reader FSM migration. The commit-reconcile-across-
// reconnect design (re-send [committed_offset, end) on the NEW partition session)
// hinges on server behaviour the proto does not state explicitly; these tests settle
// it against a live server instead of assuming.

let driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

let topicName: string
let consumerName: string

beforeEach(async () => {
	topicName = `reader-protocol-${Date.now()}`
	consumerName = `consumer-${Date.now()}`
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: topicName,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 1n },
			consumers: [{ name: consumerName }],
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: topicName }))
})

// A minimal raw StreamRead driver for the test.
type ReadStream = {
	send: (message: StreamReadMessage_FromClient, priority?: number) => void
	next: () => Promise<StreamReadMessage_FromServer>
	until: (
		serverCase: StreamReadMessage_FromServer['serverMessage']['case']
	) => Promise<StreamReadMessage_FromServer>
	close: () => void
}

let openReadStream = function openReadStream(signal: AbortSignal): ReadStream {
	let input = new AsyncPriorityQueue<StreamReadMessage_FromClient>()
	input.push(
		create(StreamReadMessage_FromClientSchema, {
			clientMessage: {
				case: 'initRequest',
				value: { consumer: consumerName, topicsReadSettings: [{ path: topicName }] },
			},
		}),
		100
	)
	let stream = driver.createClient(TopicServiceDefinition).streamRead(input, { signal })
	let iterator = stream[Symbol.asyncIterator]()

	let next = async function next(): Promise<StreamReadMessage_FromServer> {
		let result = await iterator.next()
		if (result.done) {
			throw new Error('stream ended')
		}
		let message = result.value
		if (message.status !== StatusIds_StatusCode.SUCCESS) {
			throw new YDBError(message.status, message.issues)
		}
		return message
	}

	return {
		send: (message, priority = 0) => input.push(message, priority),
		next,
		until: async (serverCase) => {
			for (;;) {
				// oxlint-disable-next-line no-await-in-loop
				let message = await next()
				if (message.serverMessage.case === serverCase) {
					return message
				}
			}
		},
		close: () => input.close(),
	}
}

let commitOffsetRequest = function commitOffsetRequest(
	partitionSessionId: bigint,
	start: bigint,
	end: bigint
): StreamReadMessage_FromClient {
	return create(StreamReadMessage_FromClientSchema, {
		clientMessage: {
			case: 'commitOffsetRequest',
			value: { commitOffsets: [{ partitionSessionId, offsets: [{ start, end }] }] },
		},
	})
}

let startResponse = function startResponse(
	partitionSessionId: bigint
): StreamReadMessage_FromClient {
	return create(StreamReadMessage_FromClientSchema, {
		clientMessage: { case: 'startPartitionSessionResponse', value: { partitionSessionId } },
	})
}

let writeMessages = async function writeMessages(count: number): Promise<void> {
	await using writer = createTopicWriter(driver, { topic: topicName, producer: 'p' })
	for (let i = 0; i < count; i++) {
		writer.write(new Uint8Array([i]))
	}
	await writer.flush()
}

test('carries the prior committed offset into a fresh partition session', async (tc) => {
	await writeMessages(5)

	// Session A: commit [0, 3).
	let a = openReadStream(tc.signal)
	try {
		let startA = await a.until('startPartitionSessionRequest')
		let psA = startA.serverMessage.value as { partitionSession: { partitionSessionId: bigint } }
		expect((startA.serverMessage.value as { committedOffset: bigint }).committedOffset).toBe(0n)
		a.send(startResponse(psA.partitionSession.partitionSessionId))
		a.send(commitOffsetRequest(psA.partitionSession.partitionSessionId, 0n, 3n))
		let ack = await a.until('commitOffsetResponse')
		let committedA = (
			ack.serverMessage.value as {
				partitionsCommittedOffsets: { committedOffset: bigint }[]
			}
		).partitionsCommittedOffsets[0]!.committedOffset
		expect(committedA).toBe(3n)
	} finally {
		a.close()
	}

	// Session B: the server must report committed_offset = 3 (survives the session).
	let b = openReadStream(tc.signal)
	try {
		let startB = await b.until('startPartitionSessionRequest')
		expect((startB.serverMessage.value as { committedOffset: bigint }).committedOffset).toBe(3n)
	} finally {
		b.close()
	}
})

test('accepts a commit re-sent on a new session for offsets not read there', async (tc) => {
	await writeMessages(5)

	// Session A: commit [0, 2) only.
	let a = openReadStream(tc.signal)
	let psA: bigint
	try {
		let startA = await a.until('startPartitionSessionRequest')
		psA = (startA.serverMessage.value as { partitionSession: { partitionSessionId: bigint } })
			.partitionSession.partitionSessionId
		a.send(startResponse(psA))
		a.send(commitOffsetRequest(psA, 0n, 2n))
		await a.until('commitOffsetResponse')
	} finally {
		a.close()
	}

	// Session B: WITHOUT reading, re-send a commit for [2, 5) — offsets that were never
	// delivered on THIS session. This is exactly the reconcile re-send; the server must
	// accept it (committed_offset advances to 5), not error the stream.
	let b = openReadStream(tc.signal)
	try {
		let startB = await b.until('startPartitionSessionRequest')
		let psB = (
			startB.serverMessage.value as { partitionSession: { partitionSessionId: bigint } }
		).partitionSession.partitionSessionId
		expect((startB.serverMessage.value as { committedOffset: bigint }).committedOffset).toBe(2n)
		b.send(startResponse(psB))
		b.send(commitOffsetRequest(psB, 2n, 5n))
		let ack = await b.until('commitOffsetResponse')
		let committed = (
			ack.serverMessage.value as {
				partitionsCommittedOffsets: { committedOffset: bigint }[]
			}
		).partitionsCommittedOffsets[0]!.committedOffset
		// The reconcile-by-resend design depends on this being 5n. If the server ever
		// rejects it, narrow re-sent ranges to [max(committed, lastReadOffset), end).
		expect(committed).toBe(5n)
	} finally {
		b.close()
	}
})
