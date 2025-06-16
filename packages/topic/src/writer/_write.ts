import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { type StreamWriteMessage_FromClient, type StreamWriteMessage_WriteRequest_MessageData, StreamWriteMessage_WriteRequest_MessageDataSchema } from "@ydbjs/api/topic";
import type { CompressionCodec } from "../codec.js";
import type { PQueue } from "../queue.js";
import { _flush } from "./_flush.js";
import { MAX_PAYLOAD_SIZE } from "./constants.js";

export function _write(ctx: {
	readonly queue: PQueue<StreamWriteMessage_FromClient>,

	readonly codec?: CompressionCodec, // Codec to use for compression
	readonly lastSeqNo: bigint, // Last sequence number used

	readonly buffer: Map<bigint, StreamWriteMessage_WriteRequest_MessageData>; // Map of sequence numbers to messages in the buffer
	readonly inflight: Set<bigint>; // Set of sequence numbers that are currently in-flight
	readonly pendingAcks: Map<bigint, { resolve: (seqNo: bigint) => void }>; // Map of sequence numbers to pending ack resolvers

	readonly bufferSize: bigint, // Current size of the buffer in bytes
	readonly maxBufferSize: bigint, // Maximum size of the buffer in bytes

	updateLastSeqNo: (seqNo: bigint) => void;
	updateBufferSize: (bytes: bigint) => void; // Function to update the buffer size
}, msg: {
	data: Uint8Array,
	seqNo?: bigint,
	createdAt?: Date,
	metadataItems?: Record<string, Uint8Array>
}): Promise<bigint> {
	let data = ctx.codec ? ctx.codec.compress(msg.data) : msg.data;

	// Validate the payload size, it should not exceed MAX_PAYLOAD_SIZE
	// This is a YDB limitation for single message size.
	if (data.length > MAX_PAYLOAD_SIZE) {
		throw new Error(`Payload size exceeds ${Number(MAX_PAYLOAD_SIZE / (1024n * 1024n))}MiB limit.`);
	}

	// Check if the buffer size exceeds the maximum allowed size
	// If it does, flush the buffer to send the messages before adding new ones.
	// This is to prevent memory overflow and ensure that the buffer does not grow indefinitely.
	if (ctx.bufferSize + BigInt(data.length) > ctx.maxBufferSize) {
		_flush(ctx); // Flush the buffer if it exceeds the maximum size.
	}

	let seqNo = msg.seqNo ?? ((ctx.lastSeqNo ?? 0n) + 1n);
	let createdAt = timestampFromDate(msg.createdAt ?? new Date());
	let metadataItems = Object.entries(msg.metadataItems || {}).map(([key, value]) => ({ key, value }));
	let uncompressedSize = BigInt(data.length);

	let message = create(StreamWriteMessage_WriteRequest_MessageDataSchema, {
		data,
		seqNo,
		createdAt,
		metadataItems,
		uncompressedSize,
	});

	ctx.buffer.set(seqNo, message); // Store the message in the buffer
	ctx.updateBufferSize(BigInt(data.length)); // Update the buffer size
	ctx.updateLastSeqNo(seqNo); // Update the last sequence number

	let pendingAck = Promise.withResolvers<bigint>()
	ctx.pendingAcks.set(seqNo, pendingAck); // Store the pending ack resolver for this sequence number.

	return pendingAck.promise
}
