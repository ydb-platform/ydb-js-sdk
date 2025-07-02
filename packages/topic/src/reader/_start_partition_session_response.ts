import { create } from "@bufbuild/protobuf";
import { type StreamReadMessage_FromClient, StreamReadMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { AsyncPriorityQueue } from "../queue.js";

export let _send_start_partition_session_response = function send_start_partition_session_response(ctx: {
	readonly queue: AsyncPriorityQueue<StreamReadMessage_FromClient>,
	readonly partitionSessionId: bigint,
	readonly readOffset: bigint,
	readonly commitOffset: bigint
}) {
	ctx.queue.push(create(StreamReadMessage_FromClientSchema, {
		clientMessage: {
			case: 'startPartitionSessionResponse',
			value: {
				partitionSessionId: ctx.partitionSessionId,
				readOffset: ctx.readOffset,
				commitOffset: ctx.commitOffset
			}
		}
	}), 0);
}
