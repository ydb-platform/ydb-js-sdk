import type { StreamWriteMessage_FromClient, StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import type { CompressionCodec } from "../codec.js";
import type { PQueue } from "../queue.js";
import { _batch_messages } from "./_batch_messages.js";
import { _emit_write_request } from "./_write_request.js";
import { MAX_INFLIGHT_COUNT } from "./constants.js";

export function _flush(ctx: {
	readonly queue: PQueue<StreamWriteMessage_FromClient>,
	readonly codec?: CompressionCodec, // Codec to use for compression
	readonly buffer: Map<bigint, StreamWriteMessage_WriteRequest_MessageData>; // Map of sequence numbers to messages in the buffer
	readonly inflight: Set<bigint>; // Set of sequence numbers that are currently in-flight
	updateBufferSize: (bytes: bigint) => void; // Function to update the buffer size
}) {
	if (!ctx.buffer.size) {
		return; // Nothing to flush
	}

	let iterator = ctx.buffer.values()
	let messagesToSend: StreamWriteMessage_WriteRequest_MessageData[] = [];

	while (ctx.inflight.size < MAX_INFLIGHT_COUNT) {
		let next = iterator.next();
		if (next.done) {
			break; // No more messages to send
		}

		let message = next.value;
		messagesToSend.push(message);
		ctx.inflight.add(message.seqNo);
	}

	if (!messagesToSend.length) {
		return; // No messages to send
	}

	for (let batch of _batch_messages(messagesToSend)) {
		_emit_write_request(ctx, batch); // Emit the write request with the batch of messages
	}
}
