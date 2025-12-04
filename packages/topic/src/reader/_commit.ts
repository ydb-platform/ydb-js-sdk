import { create } from '@bufbuild/protobuf'
import {
	type OffsetsRange,
	OffsetsRangeSchema,
	type StreamReadMessage_CommitOffsetRequest_PartitionCommitOffset,
	StreamReadMessage_CommitOffsetRequest_PartitionCommitOffsetSchema,
	StreamReadMessage_FromClientSchema,
} from '@ydbjs/api/topic'
import { loggers } from '@ydbjs/debug'

import type { TopicMessage } from '../message.js'
import type { TopicCommitPromise, TopicReaderState } from './types.js'

let dbg = loggers.topic.extend('reader')

export let _commit = function commit(
	state: TopicReaderState,
	input: TopicMessage | TopicMessage[]
): Promise<void> {
	if (state.disposed) {
		throw new Error('Reader is disposed')
	}

	let messages = Array.isArray(input) ? input : [input]
	if (!messages.length) {
		return Promise.resolve()
	}

	// Group offsets by partition session
	let offsets = new Map<bigint, OffsetsRange[]>()
	let commitOffsets: StreamReadMessage_CommitOffsetRequest_PartitionCommitOffset[] =
		[]

	for (let message of messages) {
		// Each message must be alive
		if (!message.alive) {
			throw new Error('Cannot commit dead message')
		}

		let partitionSession = message.partitionSession.deref()
		if (!partitionSession) {
			throw new Error('Cannot commit message with dead partition session')
		}

		if (!offsets.has(partitionSession.partitionSessionId)) {
			offsets.set(partitionSession.partitionSessionId, [])
		}

		let partOffsets = offsets.get(partitionSession.partitionSessionId)!
		let offset = message.offset
		if (offset === undefined) {
			throw new Error('Cannot commit message without offset')
		}

		// Optimize storage by merging consecutive offsets into ranges
		// This reduces network traffic and improves performance
		if (partOffsets.length > 0) {
			let last = partOffsets[partOffsets.length - 1]!

			if (offset === last.end) {
				// If the new offset is consecutive to the last range, extend the range
				// This creates a continuous range (e.g. 1-5 instead of 1-4, 5)
				last.end = offset + 1n
			} else if (offset > last.end) {
				// If there's a gap between offsets, create a new range
				// This handles non-consecutive offsets properly
				partOffsets.push(
					create(OffsetsRangeSchema, {
						start: offset,
						end: offset + 1n,
					})
				)
			} else {
				// If offset <= last.end, it's either out of order or a duplicate.
				throw new Error(
					`Message with offset ${offset} is out of order or duplicate for partition session ${partitionSession.partitionSessionId}`
				)
			}
		} else {
			// First offset for this partition, create initial range
			partOffsets.push(
				create(OffsetsRangeSchema, { start: offset, end: offset + 1n })
			)
		}
	}

	// Convert our optimized Map structure into the API's expected format
	for (let [partitionSessionId, partOffsets] of offsets.entries()) {
		dbg.log(
			'committing offsets for partition session %s: %o',
			partitionSessionId,
			partOffsets
		)

		commitOffsets.push(
			create(
				StreamReadMessage_CommitOffsetRequest_PartitionCommitOffsetSchema,
				{
					partitionSessionId,
					offsets: partOffsets,
				}
			)
		)
	}

	// Send the commit request to the server
	state.outgoingQueue.push(
		create(StreamReadMessage_FromClientSchema, {
			clientMessage: {
				case: 'commitOffsetRequest',
				value: {
					commitOffsets,
				},
			},
		}),
		0
	)

	// Create a promise that resolves when the commit is acknowledged by the server.
	return new Promise((resolve, reject) => {
		for (let [partitionSessionId, partOffsets] of offsets.entries()) {
			// Create a commit promise for each partition session
			let commitPromise: TopicCommitPromise = {
				partitionSessionId,
				offset: partOffsets[partOffsets.length - 1]!.end, // Use the last offset in the range
				resolve,
				reject,
			}

			// Add to pending commits map
			if (!state.pendingCommits.has(partitionSessionId)) {
				state.pendingCommits.set(partitionSessionId, [])
			}

			// Push the commit promise to the pending commits for this partition session
			state.pendingCommits.get(partitionSessionId)!.push(commitPromise)
		}
	})
}
