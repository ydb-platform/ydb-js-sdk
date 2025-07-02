import { loggers } from "@ydbjs/debug"
import type { StreamReadMessage_InitResponse } from "@ydbjs/api/topic"
import type { AsyncPriorityQueue } from "../queue.js"
import type { StreamReadMessage_FromClient } from "@ydbjs/api/topic"

let dbg = loggers.topic.extend('reader')

export let _on_init_response = function on_init_response(
	ctx: {
		readonly outgoingQueue: AsyncPriorityQueue<StreamReadMessage_FromClient>
		readonly freeBufferSize: bigint
	},
	input: StreamReadMessage_InitResponse
): void {
	dbg.log('read session identifier: %s', input.sessionId)

	// Request initial data
	import("./_read_request.js").then(({ _send_read_request }) => {
		_send_read_request({
			queue: ctx.outgoingQueue,
			bytesSize: ctx.freeBufferSize
		})
	})
}
