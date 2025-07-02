import * as assert from "node:assert"
import { once } from "node:events"
import { loggers } from "@ydbjs/debug"
import { _send_stop_partition_session_response } from "./_stop_partition_session_response.js"
import type { StreamReadMessage_ReadResponse, StreamReadMessage_StopPartitionSessionRequest } from "@ydbjs/api/topic"
import type { AsyncPriorityQueue } from "../queue.js"
import type { StreamReadMessage_FromClient } from "@ydbjs/api/topic"
import type { TopicPartitionSession } from "../partition-session.js"
import type { TopicCommitPromise, onPartitionSessionStopCallback } from "./types.js"

let dbg = loggers.topic.extend('reader')

export let _on_stop_partition_session_request = async function on_stop_partition_session_request(
	ctx: {
		readonly partitionSessions: Map<bigint, TopicPartitionSession>
		readonly outgoingQueue: AsyncPriorityQueue<StreamReadMessage_FromClient>
		readonly buffer: StreamReadMessage_ReadResponse[]
		readonly disposed: boolean
		readonly onPartitionSessionStop?: onPartitionSessionStopCallback
		readonly pendingCommits?: Map<bigint, TopicCommitPromise[]> // Optional for regular reader
	},
	input: StreamReadMessage_StopPartitionSessionRequest
): Promise<void> {
	assert.ok(input.partitionSessionId, 'stopPartitionSessionRequest must have partitionSessionId')

	let partitionSession = ctx.partitionSessions.get(input.partitionSessionId)
	if (!partitionSession) {
		dbg.log('error: stopPartitionSessionRequest for unknown partitionSessionId=%s', input.partitionSessionId)
		return
	}

	if (ctx.onPartitionSessionStop) {
		let committedOffset = input.committedOffset || 0n

		await ctx.onPartitionSessionStop(partitionSession, committedOffset).catch((err) => {
			dbg.log('error: onPartitionSessionStop error: %O', err)
			// Error will be propagated via exception if needed
		})
	}

	// If graceful stop is not requested, we can stop the partition session immediately.
	if (!input.graceful) {
		dbg.log('stop partition session %s without graceful stop', partitionSession.partitionSessionId)
		partitionSession.stop()

		// Remove all messages from the buffer that belong to this partition session.
		for (let part of ctx.buffer) {
			let i = 0
			while (i < part.partitionData.length) {
				if (part.partitionData[i]!.partitionSessionId === partitionSession.partitionSessionId) {
					part.partitionData.splice(i, 1)
				} else {
					i++
				}
			}
		}

		// Handle pending commits if they exist (only for regular reader)
		if (ctx.pendingCommits) {
			let pendingCommits = ctx.pendingCommits.get(partitionSession.partitionSessionId)
			if (pendingCommits) {
				// If there are pending commits for this partition session, reject them.
				for (let commit of pendingCommits) {
					commit.reject('Partition session stopped without graceful stop')
				}

				ctx.pendingCommits.delete(partitionSession.partitionSessionId)
			}
		}

		ctx.partitionSessions.delete(partitionSession.partitionSessionId)
		partitionSession = undefined

		return
	}

	// Handle graceful stop with pending commits (only for regular reader)
	if (ctx.pendingCommits && ctx.pendingCommits.has(partitionSession.partitionSessionId)) {
		await Promise.race([
			Promise.all(ctx.pendingCommits.get(partitionSession.partitionSessionId)!),
			once(AbortSignal.timeout(30_000), 'abort'),
		])
	}

	if (ctx.disposed) {
		return
	}

	if (ctx.pendingCommits && ctx.pendingCommits.has(partitionSession.partitionSessionId)) {
		// If there are pending commits for this partition session, reject them.
		for (let commit of ctx.pendingCommits.get(partitionSession.partitionSessionId)!) {
			commit.reject('Partition session stopped after timeout during graceful stop')
		}

		ctx.pendingCommits.delete(partitionSession.partitionSessionId)
	}

	_send_stop_partition_session_response({
		queue: ctx.outgoingQueue,
		partitionSessionId: partitionSession.partitionSessionId
	})
}
