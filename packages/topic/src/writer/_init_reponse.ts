import type { StreamWriteMessage_FromClient, StreamWriteMessage_InitResponse, StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import type { CompressionCodec } from "../codec.js";
import type { AsyncPriorityQueue } from "../queue.js";
import type { TX } from "../tx.js";
import { _flush } from "./_flush.js";
import type { ThroughputSettings } from "./types.js";

export function _on_init_response(ctx: {
	readonly tx?: TX
	readonly queue: AsyncPriorityQueue<StreamWriteMessage_FromClient>,
	readonly codec: CompressionCodec, // Codec to use for compression
	readonly buffer: StreamWriteMessage_WriteRequest_MessageData[]; // Array of messages in the buffer
	readonly inflight: StreamWriteMessage_WriteRequest_MessageData[]; // Array of messages that are currently in-flight
	readonly lastSeqNo?: bigint; // The last sequence number acknowledged by the server
	readonly throughputSettings: ThroughputSettings; // Current throughput settings for the writer
	updateLastSeqNo: (seqNo: bigint) => void;
	updateBufferSize: (bytes: bigint) => void; // Function to update the buffer size
}, input: StreamWriteMessage_InitResponse) {
	if (!ctx.lastSeqNo) {
		// Store the last sequence number from the server.
		ctx.updateLastSeqNo(input.lastSeqNo);
	}

	while (ctx.inflight.length > 0) {
		const message = ctx.inflight.pop();
		if (!message) continue;

		ctx.buffer.unshift(message);
		ctx.updateBufferSize(BigInt(message.data.length));
	}

	_flush(ctx); // Flush the buffer to send any pending messages.
}
