import { loggers } from "@ydbjs/debug"
import type { StreamReadMessage_ReadResponse } from "@ydbjs/api/topic"

let dbg = loggers.topic.extend('reader')

export let _on_read_response = function on_read_response(
	ctx: {
		readonly buffer: StreamReadMessage_ReadResponse[]
		readonly updateFreeBufferSize: (deltaBytes: bigint) => void
	},
	input: StreamReadMessage_ReadResponse
): void {
	dbg.log('reader received %d bytes', input.bytesSize)

	ctx.buffer.push(input)
	ctx.updateFreeBufferSize(-input.bytesSize) // Decrease free buffer size
}
