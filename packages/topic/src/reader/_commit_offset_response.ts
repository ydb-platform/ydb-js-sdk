import * as assert from "node:assert"
import { loggers } from "@ydbjs/debug"
import type { StreamReadMessage_CommitOffsetResponse } from "@ydbjs/api/topic"
import type { TopicPartitionSession } from "../partition-session.js"
import type { TopicCommitPromise, onCommittedOffsetCallback } from "./types.js"

let dbg = loggers.topic.extend('reader')

export let _on_commit_offset_response = function on_commit_offset_response(
	ctx: {
		readonly pendingCommits: Map<bigint, TopicCommitPromise[]>
		readonly partitionSessions: Map<bigint, TopicPartitionSession>
		readonly onCommittedOffset?: onCommittedOffsetCallback
	},
	input: StreamReadMessage_CommitOffsetResponse
): void {
	assert.ok(input.partitionsCommittedOffsets, 'commitOffsetResponse must have partitionsCommittedOffsets')

	if (ctx.onCommittedOffset) {
		for (let part of input.partitionsCommittedOffsets) {
			let partitionSession = ctx.partitionSessions.get(part.partitionSessionId)
			if (!partitionSession) {
				dbg.log('error: commitOffsetResponse for unknown partitionSessionId=%s', part.partitionSessionId)
				continue
			}

			ctx.onCommittedOffset(partitionSession, part.committedOffset)
		}
	}

	// Resolve all pending commits for the partition sessions.
	for (let part of input.partitionsCommittedOffsets) {
		let partitionSessionId = part.partitionSessionId
		let committedOffset = part.committedOffset

		// Resolve all pending commits for this partition session.
		let pendingCommits = ctx.pendingCommits.get(partitionSessionId)
		if (pendingCommits) {
			let i = 0
			while (i < pendingCommits.length) {
				let commit = pendingCommits[i]!
				if (commit.offset <= committedOffset) {
					// If the commit offset is less than or equal to the committed offset, resolve it.
					commit.resolve()
					pendingCommits.splice(i, 1) // Remove from pending commits
				} else {
					i++
				}
			}
		}

		// If there are no pending commits for this partition session, remove it from the map.
		if (pendingCommits && pendingCommits.length === 0) {
			ctx.pendingCommits.delete(partitionSessionId)
		}
	}
}
