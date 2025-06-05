import { EventEmitter } from "node:events";

import { create } from "@bufbuild/protobuf";
import { Codec, StreamWriteMessage_FromClientSchema, type StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import type { OutgoingEventMap } from "./types.ts";

export function _emit_write_request(ctx: {
	readonly ee: EventEmitter<OutgoingEventMap>,
	readonly codec: Codec,
}, messages: StreamWriteMessage_WriteRequest_MessageData[]) {
	return ctx.ee.emit('message', create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'writeRequest',
			value: {
				messages,
				codec: ctx.codec,
			}
		}
	}));
}
