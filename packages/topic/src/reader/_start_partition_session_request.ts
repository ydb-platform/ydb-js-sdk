import * as assert from 'node:assert'
import { loggers } from '@ydbjs/debug'
import { TopicPartitionSession } from '../partition-session.js'
import { _send_start_partition_session_response } from './_start_partition_session_response.js'
import type { StreamReadMessage_StartPartitionSessionRequest } from '@ydbjs/api/topic'
import type { AsyncPriorityQueue } from '../queue.js'
import type { StreamReadMessage_FromClient } from '@ydbjs/api/topic'
import type { onPartitionSessionStartCallback } from './types.js'

let dbg = loggers.topic.extend('reader')

export let _on_start_partition_session_request =
	async function on_start_partition_session_request(
		ctx: {
			readonly partitionSessions: Map<bigint, TopicPartitionSession>
			readonly outgoingQueue: AsyncPriorityQueue<StreamReadMessage_FromClient>
			readonly onPartitionSessionStart?: onPartitionSessionStartCallback
		},
		input: StreamReadMessage_StartPartitionSessionRequest
	): Promise<void> {
		assert.ok(
			input.partitionSession,
			'startPartitionSessionRequest must have partitionSession'
		)
		assert.ok(
			input.partitionOffsets,
			'startPartitionSessionRequest must have partitionOffsets'
		)

		dbg.log(
			'receive partition with id %s',
			input.partitionSession.partitionId
		)

		// Create a new partition session.
		let partitionSession: TopicPartitionSession = new TopicPartitionSession(
			input.partitionSession.partitionSessionId,
			input.partitionSession.partitionId,
			input.partitionSession.path
		)

		// Initialize partition session state from server data.
		// nextCommitStartOffset fills gaps when messages are deleted by retention.
		partitionSession.nextCommitStartOffset = input.committedOffset
		partitionSession.partitionCommittedOffset = input.committedOffset
		partitionSession.partitionOffsets = {
			start: input.partitionOffsets.start,
			end: input.partitionOffsets.end,
		}

		// Save partition session.
		ctx.partitionSessions.set(
			partitionSession.partitionSessionId,
			partitionSession
		)

		// Initialize offsets.
		let readOffset = input.partitionOffsets.start
		let commitOffset = input.committedOffset

		// Call onPartitionSessionStart callback if it is defined.
		if (ctx.onPartitionSessionStart) {
			let committedOffset = input.committedOffset
			let partitionOffsets = input.partitionOffsets

			let response = await ctx
				.onPartitionSessionStart(
					partitionSession,
					committedOffset,
					partitionOffsets
				)
				.catch((error) => {
					dbg.log('error: onPartitionSessionStart error: %O', error)
					// Error will be propagated via exception if needed
					return undefined
				})

			if (response) {
				readOffset = response.readOffset || 0n
				commitOffset = response.commitOffset || 0n
			}
		}

		_send_start_partition_session_response({
			queue: ctx.outgoingQueue,
			partitionSessionId: partitionSession.partitionSessionId,
			readOffset,
			commitOffset,
		})
	}
