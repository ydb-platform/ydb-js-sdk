import { create } from "@bufbuild/protobuf";
import { Codec, type StreamWriteMessage_FromClient, StreamWriteMessage_FromClientSchema, type StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import type { PQueue } from "../queue.js";

export function _emit_write_request(ctx: {
	readonly queue: PQueue<StreamWriteMessage_FromClient>,
	readonly codec: Codec,
}, messages: StreamWriteMessage_WriteRequest_MessageData[]) {
	return ctx.queue.push(create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'writeRequest',
			value: {
				messages,
				codec: ctx.codec,
			}
		}
	}));
}
