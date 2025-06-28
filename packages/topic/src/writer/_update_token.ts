import { create } from "@bufbuild/protobuf";
import { type StreamWriteMessage_FromClient, StreamWriteMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { AsyncPriorityQueue } from "../queue.js";

export const _send_update_token_request = function send_update_token_request(ctx: {
	readonly queue: AsyncPriorityQueue<StreamWriteMessage_FromClient>,
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
