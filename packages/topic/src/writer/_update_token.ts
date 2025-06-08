import { create } from "@bufbuild/protobuf";
import { type StreamWriteMessage_FromClient, StreamWriteMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { PQueue } from "../queue.js";

export function _send_update_token_request(ctx: {
	readonly queue: PQueue<StreamWriteMessage_FromClient>,
	readonly token: string
}) {
	return ctx.queue.push(create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'updateTokenRequest',
			value: {
				token: ctx.token
			}
		}
	}), 10);
}
