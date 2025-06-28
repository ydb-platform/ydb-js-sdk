import type { StreamWriteMessage_FromClient, StreamWriteMessage_WriteRequest_MessageData, StreamWriteMessage_WriteResponse } from "@ydbjs/api/topic";
import type { CompressionCodec } from "../codec.js";
import type { AsyncPriorityQueue } from "../queue.js";
import type { TX } from "../tx.js";
import { _flush } from "./_flush.js";
import type { ThroughputSettings } from "./types.js";

export const _on_write_response = function on_write_response(ctx: {
	readonly tx?: TX
	readonly queue: AsyncPriorityQueue<StreamWriteMessage_FromClient>,
	readonly codec: CompressionCodec, // Codec to use for compression
	readonly buffer: StreamWriteMessage_WriteRequest_MessageData[]; // Array of messages that are currently in-flight
	readonly inflight: StreamWriteMessage_WriteRequest_MessageData[]; // Array of messages that are currently in-flight
	readonly throughputSettings: ThroughputSettings; // Current throughput settings for the writer
	onAck?: (seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void // Callback for handling acknowledgments
	updateBufferSize: (bytes: bigint) => void; // Function to update the buffer size
}, input: StreamWriteMessage_WriteResponse) {
	// Process each acknowledgment in the response.

	let acks = new Map<bigint, 'skipped' | 'written' | 'writtenInTx'>();
	for (let ack of input.acks) {
		acks.set(ack.seqNo, ack.messageWriteStatus.case!);
	}

	// Acknowledge messages that have been processed.
	for (let i = ctx.inflight.length - 1; i >= 0; i--) {
		const message = ctx.inflight[i]!;
		if (acks.has(message.seqNo)) {
			ctx.onAck?.(message.seqNo, acks.get(message.seqNo));
			ctx.inflight.splice(i, 1);
		}
	}

	// Clear the acknowledgment map.
	acks.clear();

	// If there are still messages in the buffer, flush them.
	_flush(ctx)
}
