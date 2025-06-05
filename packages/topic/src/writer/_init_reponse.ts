import { EventEmitter } from "node:events";

import type { Codec, StreamWriteMessage_InitResponse, StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import { _flush } from "./_flush.ts";
import type { OutgoingEventMap } from "./types.ts";

export function _on_init_response(ctx: {
	readonly ee: EventEmitter<OutgoingEventMap>,
	readonly codec: Codec,
	readonly buffer: Map<bigint, StreamWriteMessage_WriteRequest_MessageData>; // Map of sequence numbers to messages in the buffer
	readonly inflight: Set<bigint>; // Set of sequence numbers that are currently in-flight
	readonly lastSeqNo?: bigint; // The last sequence number acknowledged by the server

	updateLastSeqNo: (seqNo: bigint) => void;
	updateBufferSize: (bytes: bigint) => void; // Function to update the buffer size
}, input: StreamWriteMessage_InitResponse) {
	if (!ctx.lastSeqNo) {
		// Store the last sequence number from the server.
		ctx.updateLastSeqNo(input.lastSeqNo);
	}

	if (ctx.inflight.size > 0) {
		ctx.inflight.clear(); // Clear the in-flight set if there are any messages in-flight
	}

	_flush(ctx); // Flush the buffer to send any pending messages.
}
