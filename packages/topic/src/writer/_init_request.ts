import { create } from "@bufbuild/protobuf";
import { type StreamWriteMessage_FromClient, StreamWriteMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { AsyncPriorityQueue } from "../queue.js";

export function _send_init_request(ctx: {
	readonly queue: AsyncPriorityQueue<StreamWriteMessage_FromClient>,
	readonly topic: string;
	readonly producer?: string;
	readonly getLastSeqNo?: boolean;
}) {
	return ctx.queue.push(create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'initRequest',
			value: {
				path: ctx.topic,
				producerId: ctx.producer,
				getLastSeqNo: ctx.getLastSeqNo,
			}
		}
	}), 100);
}
