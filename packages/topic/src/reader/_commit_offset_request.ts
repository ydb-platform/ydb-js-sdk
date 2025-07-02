import { create } from "@bufbuild/protobuf";
import { type StreamReadMessage_CommitOffsetRequest_PartitionCommitOffset, type StreamReadMessage_FromClient, StreamReadMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { AsyncPriorityQueue } from "../queue.js";

export let _send_commit_offset_request = function send_commit_offset_request(ctx: {
	readonly queue: AsyncPriorityQueue<StreamReadMessage_FromClient>,
	readonly commitOffsets: StreamReadMessage_CommitOffsetRequest_PartitionCommitOffset[]
}) {
	ctx.queue.push(create(StreamReadMessage_FromClientSchema, {
		clientMessage: {
			case: 'commitOffsetRequest',
			value: {
				commitOffsets: ctx.commitOffsets
			}
		}
	}), 0);
}
