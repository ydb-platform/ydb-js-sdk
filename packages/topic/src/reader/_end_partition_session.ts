import * as assert from "node:assert"
import { loggers } from "@ydbjs/debug"
import type { StreamReadMessage_EndPartitionSession } from "@ydbjs/api/topic"
import type { TopicPartitionSession } from "../partition-session.js"

let dbg = loggers.topic.extend('reader')

export let _on_end_partition_session = function on_end_partition_session(
	ctx: {
		readonly partitionSessions: Map<bigint, TopicPartitionSession>
	},
	input: StreamReadMessage_EndPartitionSession
): void {
	assert.ok(input.partitionSessionId, 'endPartitionSession must have partitionSessionId')

	let partitionSession = ctx.partitionSessions.get(input.partitionSessionId)
	if (!partitionSession) {
		dbg.log('error: endPartitionSession for unknown partitionSessionId=%s', input.partitionSessionId)
		return
	}

	partitionSession.end()
}
