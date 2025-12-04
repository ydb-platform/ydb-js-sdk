import { create } from '@bufbuild/protobuf'
import {
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromClientSchema,
	type StreamReadMessage_InitRequest_TopicReadSettings,
} from '@ydbjs/api/topic'
import type { AsyncPriorityQueue } from '../queue.js'

export let _send_init_request = function send_init_request(ctx: {
	readonly queue: AsyncPriorityQueue<StreamReadMessage_FromClient>
	readonly consumer: string
	readonly topicsReadSettings: StreamReadMessage_InitRequest_TopicReadSettings[]
}) {
	ctx.queue.push(
		create(StreamReadMessage_FromClientSchema, {
			clientMessage: {
				case: 'initRequest',
				value: {
					consumer: ctx.consumer,
					topicsReadSettings: ctx.topicsReadSettings,
					autoPartitioningSupport: false,
				},
			},
		}),
		0
	)
}
