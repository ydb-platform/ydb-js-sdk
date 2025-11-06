import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import {
	type StreamWriteMessage_WriteRequest_MessageData,
	StreamWriteMessage_WriteRequest_MessageDataSchema,
} from '@ydbjs/api/topic'
import type { CompressionCodec } from '../codec.js'
import { _flush } from './_flush.js'
import { MAX_PAYLOAD_SIZE } from './constants.js'

export function _write(
	ctx: {
		readonly codec: CompressionCodec // Codec to use for compression
		readonly buffer: StreamWriteMessage_WriteRequest_MessageData[] // Array of messages in the buffer
		readonly inflight: StreamWriteMessage_WriteRequest_MessageData[] // Array of messages that are currently in-flight
		readonly lastSeqNo: bigint // Last sequence number used
		updateLastSeqNo: (seqNo: bigint) => void
		updateBufferSize: (bytes: bigint) => void // Function to update the buffer size
	},
	msg: {
		data: Uint8Array
		seqNo?: bigint
		createdAt?: Date
		metadataItems?: Record<string, Uint8Array>
	}
): bigint {
	let data = ctx.codec ? ctx.codec.compress(msg.data) : msg.data

	// Validate the payload size, it should not exceed MAX_PAYLOAD_SIZE
	// This is a YDB limitation for single message size.
	if (data.length > MAX_PAYLOAD_SIZE) {
		throw new Error(
			`Payload size exceeds ${Number(MAX_PAYLOAD_SIZE / (1024n * 1024n))}MiB limit.`
		)
	}

	let seqNo = msg.seqNo ?? (ctx.lastSeqNo ?? 0n) + 1n
	let createdAt = timestampFromDate(msg.createdAt ?? new Date())
	let metadataItems = Object.entries(msg.metadataItems || {}).map(
		([key, value]) => ({ key, value })
	)
	let uncompressedSize = BigInt(data.length)

	let message = create(StreamWriteMessage_WriteRequest_MessageDataSchema, {
		data,
		seqNo,
		createdAt,
		metadataItems,
		uncompressedSize,
	})

	ctx.buffer.push(message) // Store the message in the buffer
	ctx.updateBufferSize(BigInt(data.length)) // Update the buffer size

	// Only update lastSeqNo if session is initialized (lastSeqNo is defined)
	// For messages written before session initialization, lastSeqNo will be updated
	// after renumbering in _on_init_response
	if (ctx.lastSeqNo !== undefined) {
		ctx.updateLastSeqNo(seqNo)
	}

	return seqNo
}
