import { create } from "@bufbuild/protobuf";
import { type StreamReadMessage_FromClient, StreamReadMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { AsyncPriorityQueue } from "../queue.js";

export let _send_read_request = function send_read_request(ctx: {
	readonly queue: AsyncPriorityQueue<StreamReadMessage_FromClient>,
	readonly bytesSize: bigint
}) {
	ctx.queue.push(create(StreamReadMessage_FromClientSchema, {
		clientMessage: {
			case: 'readRequest',
			value: {
				bytesSize: ctx.bytesSize
			}
		}
	}), 0);
}
