import { create } from '@bufbuild/protobuf'
import {
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromClientSchema,
} from '@ydbjs/api/topic'
import type { AsyncPriorityQueue } from '../queue.js'

export let _send_update_token_request =
	function send_update_token_request(ctx: {
		readonly queue: AsyncPriorityQueue<StreamReadMessage_FromClient>
		readonly token: string
	}) {
		ctx.queue.push(
			create(StreamReadMessage_FromClientSchema, {
				clientMessage: {
					case: 'updateTokenRequest',
					value: {
						token: ctx.token,
					},
				},
			}),
			0
		)
	}
