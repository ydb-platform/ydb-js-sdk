import { EventEmitter } from "node:events";

import type { Codec, StreamWriteMessage_WriteRequest_MessageData, StreamWriteMessage_WriteResponse } from "@ydbjs/api/topic";
import { _flush } from "./_flush.ts";
import type { OutgoingEventMap } from "./types.ts";

export function _on_write_response(ctx: {
	readonly ee: EventEmitter<OutgoingEventMap>,
	readonly codec: Codec,
	readonly buffer: Map<bigint, StreamWriteMessage_WriteRequest_MessageData>; // Map of sequence numbers to messages in the buffer
	readonly inflight: Set<bigint>; // Set of sequence numbers that are currently in-flight
	readonly pendingAcks: Map<bigint, { resolve: (seqNo: bigint) => void }>; // Map of sequence numbers to pending ack resolvers
	onAck?: (seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void // Callback for handling acknowledgments
	updateBufferSize: (bytes: bigint) => void; // Function to update the buffer size
}, input: StreamWriteMessage_WriteResponse) {
	// Process each acknowledgment in the response.
	// This will resolve the pending ack promises and remove the messages from the buffer.
	for (let ack of input.acks) {
		ctx.onAck?.(ack.seqNo, ack.messageWriteStatus.case);

		// Remove the acknowledged message from the buffer.
		let message = ctx.buffer.get(ack.seqNo);
		if (message) {
			ctx.buffer.delete(ack.seqNo);
			ctx.updateBufferSize(-BigInt(message.data.length));

			// Resolve the pending ack promise for this sequence number.
			let pendingAck = ctx.pendingAcks.get(ack.seqNo);
			if (pendingAck) {
				pendingAck.resolve(ack.seqNo);
				ctx.pendingAcks.delete(ack.seqNo);
			}

			// Decrease the in-flight count.
			ctx.inflight.delete(ack.seqNo);
		}
	}

	// If there are still messages in the buffer, flush them.
	_flush(ctx)
}
