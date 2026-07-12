import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	type StreamWriteMessage_FromClient,
	StreamWriteMessage_FromClientSchema,
	type StreamWriteMessage_FromServer,
	type StreamWriteMessage_InitResponse,
	type StreamWriteMessage_WriteResponse,
	StreamWriteMessage_WriteResponse_WriteAck_Skipped_Reason,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { AsyncPriorityQueue } from '@ydbjs/fsm/queue'
import { ClientError, Status } from 'nice-grpc'

import { createTopicWriter } from '../src/writer/index.js'
import { isRetryableWriterError } from '../src/writer/writer-state.js'

// Real-YDB protocol truth for the writer FSM migration. The reconnect dedup design
// (drop in-flight messages the server already persisted, walk acks as an ordered
// prefix) hinges on server behaviour the proto does not state explicitly; these
// tests settle it against a live server instead of assuming.

let driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
await driver.ready()

let topicService = driver.createClient(TopicServiceDefinition)

let topicName: string

beforeEach(async () => {
	topicName = `writer-protocol-${Date.now()}`
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: topicName,
			partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 1n },
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: topicName }))
})

// A minimal raw StreamWrite driver for the test.
type WriteStream = {
	send: (message: StreamWriteMessage_FromClient, priority?: number) => void
	next: () => Promise<StreamWriteMessage_FromServer>
	until: (
		serverCase: StreamWriteMessage_FromServer['serverMessage']['case']
	) => Promise<StreamWriteMessage_FromServer>
	close: () => void
}

let openWriteStream = function openWriteStream(
	producerId: string,
	getLastSeqNo: boolean,
	signal: AbortSignal
): WriteStream {
	let input = new AsyncPriorityQueue<StreamWriteMessage_FromClient>()
	input.push(
		create(StreamWriteMessage_FromClientSchema, {
			clientMessage: {
				case: 'initRequest',
				value: { path: topicName, producerId, getLastSeqNo },
			},
		}),
		100
	)
	let stream = driver.createClient(TopicServiceDefinition).streamWrite(input, { signal })
	let iterator = stream[Symbol.asyncIterator]()

	let next = async function next(): Promise<StreamWriteMessage_FromServer> {
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

let writeRequest = function writeRequest(
	seqNos: bigint[],
	payload = new Uint8Array([1])
): StreamWriteMessage_FromClient {
	return create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'writeRequest',
			value: {
				codec: Codec.RAW,
				messages: seqNos.map((seqNo) => ({
					seqNo,
					data: payload,
					createdAt: timestampFromDate(new Date()),
					uncompressedSize: BigInt(payload.length),
				})),
			},
		},
	})
}

// Collect write acks (possibly split across several WriteResponses) until `count`
// have arrived, preserving arrival order.
let collectAcks = async function collectAcks(
	stream: WriteStream,
	count: number
): Promise<StreamWriteMessage_WriteResponse['acks']> {
	let acks: StreamWriteMessage_WriteResponse['acks'] = []
	while (acks.length < count) {
		// oxlint-disable-next-line no-await-in-loop
		let response = await stream.until('writeResponse')
		acks.push(...(response.serverMessage.value as StreamWriteMessage_WriteResponse).acks)
	}
	return acks
}

test('reports the persisted last seqNo on init without requesting it', async (tc) => {
	// Persist seqNos 1..3 under producer 'p' through the real writer, then close.
	{
		await using writer = createTopicWriter(driver, { topic: topicName, producer: 'p' })
		writer.write(new Uint8Array([1]))
		writer.write(new Uint8Array([2]))
		writer.write(new Uint8Array([3]))
		let last = await writer.flush(tc.signal)
		expect(last).toBe(3n)
	}

	// A fresh raw session for the same producer with get_last_seq_no: FALSE. The
	// proto documents last_seq_no as filled only "if 'get_last_seq_no' was true",
	// yet the server reports the persisted high-water mark anyway. The writer's
	// reconnect dedup (writer-state.ts applyInit) leans on this as an optimization:
	// it skips resending in-flight messages the server already persisted.
	let stream = openWriteStream('p', false, tc.signal)
	try {
		let init = await stream.until('initResponse')
		let value = init.serverMessage.value as StreamWriteMessage_InitResponse
		expect(value.lastSeqNo).toBe(3n)
	} finally {
		stream.close()
	}
})

test('acknowledges duplicate seqNos per message as already written', async (tc) => {
	// Persist seqNos 1..3 (manual mode) and close the session.
	{
		await using writer = createTopicWriter(driver, { topic: topicName, producer: 'p' })
		writer.write(new Uint8Array([1]), { seqNo: 1n })
		writer.write(new Uint8Array([2]), { seqNo: 2n })
		writer.write(new Uint8Array([3]), { seqNo: 3n })
		await writer.flush(tc.signal)
	}

	// Resend a batch overlapping the persisted range on a fresh session. The server
	// must ack EVERY message individually and in order — duplicates as
	// skipped/ALREADY_WRITTEN, the new one as written. The writer's prefix ack walk
	// (writer-state.ts acknowledge) depends on per-message ordered acks.
	let stream = openWriteStream('p', false, tc.signal)
	try {
		await stream.until('initResponse')
		stream.send(writeRequest([2n, 3n, 4n]))

		let acks = await collectAcks(stream, 3)
		expect(acks.map((ack) => ack.seqNo)).toEqual([2n, 3n, 4n])

		expect(acks[0]!.messageWriteStatus.case).toBe('skipped')
		expect(acks[1]!.messageWriteStatus.case).toBe('skipped')
		for (let ack of acks.slice(0, 2)) {
			expect((ack.messageWriteStatus.value as { reason: number }).reason).toBe(
				StreamWriteMessage_WriteResponse_WriteAck_Skipped_Reason.ALREADY_WRITTEN
			)
		}
		expect(acks[2]!.messageWriteStatus.case).toBe('written')
	} finally {
		stream.close()
	}
})

test('rejects an oversized payload with a permanent error', async (tc) => {
	// Captured against local-ydb 25.3 with the driver defaults
	// (grpc.max_send_message_length = 67108864; the server's gRPC receive cap
	// observed as 64000000):
	//   - single payloads of 48MiB+1, 50MB+1 and 55MiB were ACCEPTED and acked
	//     'written' — the topic layer enforced no 48MiB per-message cap; the SDK
	//     facade cap (MAX_PAYLOAD_BYTES) is the conservative client-side bound.
	//   - 63MiB (frame 66060326 > server cap 64000000): the SERVER rejects the
	//     frame at its gRPC layer and the stream fails with
	//       ClientError { name: 'ClientError', code: 8 (RESOURCE_EXHAUSTED),
	//         path: '/Ydb.Topic.V1.TopicService/StreamWrite',
	//         details: 'Received message larger than max (66060326 vs. 64000000)' }
	//       message: '/Ydb.Topic.V1.TopicService/StreamWrite RESOURCE_EXHAUSTED:
	//         Received message larger than max (66060326 vs. 64000000)'
	//   - 64MiB+1 (over the client send cap): grpc-js refuses to send;
	//       ClientError { code: 8 (RESOURCE_EXHAUSTED),
	//         details: 'Attempted to send message with a size larger than 67108864' }
	// Both shapes are ClientError RESOURCE_EXHAUSTED with a 'larger than' size
	// complaint. The generic retry classifier retries RESOURCE_EXHAUSTED (genuine
	// throttling), so isPayloadTooLargeError (writer-state.ts) demotes exactly this
	// shape to fatal — resending the same oversized frame can only fail again.

	// Server-side rejection: over the server's frame cap, under the client's.
	{
		let stream = openWriteStream('p', false, tc.signal)
		let error: unknown
		try {
			await stream.until('initResponse')
			stream.send(writeRequest([1n], new Uint8Array(63 * 1024 * 1024)))
			await stream.until('writeResponse')
		} catch (caught) {
			error = caught
		} finally {
			stream.close()
		}

		expect(error).toBeInstanceOf(ClientError)
		expect((error as ClientError).code).toBe(Status.RESOURCE_EXHAUSTED)
		expect((error as ClientError).details).toMatch(/Received message larger than max/)
		expect(isRetryableWriterError(error)).toBe(false)
	}

	// Client-side rejection: over the 64MiB client gRPC send cap.
	{
		let stream = openWriteStream('p', false, tc.signal)
		let error: unknown
		try {
			await stream.until('initResponse')
			stream.send(writeRequest([1n], new Uint8Array(64 * 1024 * 1024 + 1)))
			await stream.until('writeResponse')
		} catch (caught) {
			error = caught
		} finally {
			stream.close()
		}

		expect(error).toBeInstanceOf(ClientError)
		expect((error as ClientError).code).toBe(Status.RESOURCE_EXHAUSTED)
		expect((error as ClientError).details).toMatch(
			/Attempted to send message with a size larger than/
		)
		expect(isRetryableWriterError(error)).toBe(false)
	}
})
