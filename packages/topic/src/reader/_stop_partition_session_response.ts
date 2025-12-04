import { create } from '@bufbuild/protobuf'
import {
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromClientSchema,
} from '@ydbjs/api/topic'
import type { AsyncPriorityQueue } from '../queue.js'

export let _send_stop_partition_session_response =
	function send_stop_partition_session_response(ctx: {
		readonly queue: AsyncPriorityQueue<StreamReadMessage_FromClient>
		readonly partitionSessionId: bigint
	}) {
		ctx.queue.push(
			create(StreamReadMessage_FromClientSchema, {
				clientMessage: {
					case: 'stopPartitionSessionResponse',
					value: {
						partitionSessionId: ctx.partitionSessionId,
					},
				},
			}),
			0
		)
	}
