import type { StreamWriteMessage_FromClient, StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import type { CompressionCodec } from "../codec.js";
import type { AsyncPriorityQueue } from "../queue.js";
import type { TX } from "../tx.js";
import { _batch_messages } from "./_batch_messages.js";
import { _emit_write_request } from "./_write_request.js";
import type { ThroughputSettings } from "./types.js";

export function _flush(ctx: {
	readonly tx?: TX
	readonly queue: AsyncPriorityQueue<StreamWriteMessage_FromClient>,
	readonly codec: CompressionCodec, // Codec to use for compression
	readonly buffer: StreamWriteMessage_WriteRequest_MessageData[]; // Array of messages in the buffer
	readonly inflight: StreamWriteMessage_WriteRequest_MessageData[]; // Array of messages that are currently in-flight
	readonly throughputSettings: ThroughputSettings;
	updateBufferSize: (bytes: bigint) => void; // Function to update the buffer size
}) {
	if (!ctx.buffer.length) {
		return; // Nothing to flush
	}

	let messagesToSend: StreamWriteMessage_WriteRequest_MessageData[] = [];

	while (ctx.inflight.length < ctx.throughputSettings.maxInflightCount) {
		let message = ctx.buffer.shift();
		if (!message) {
			break; // No more messages to send
		}

		ctx.inflight.push(message);
		messagesToSend.push(message);
	}

	for (let batch of _batch_messages(messagesToSend)) {
		_emit_write_request(ctx, batch); // Emit the write request with the batch of messages
	}
}
