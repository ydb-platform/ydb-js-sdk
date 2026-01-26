import * as assert from 'node:assert'
import { test } from 'vitest'
import { Codec } from '@ydbjs/api/topic'

import { TopicPartitionSession } from '../partition-session.js'
import { TopicMessage } from '../message.js'
import { AsyncPriorityQueue } from '../queue.js'
import { _commit } from './_commit.js'
import type { TopicReaderState } from './types.js'

/**
 * Creates a minimal TopicReaderState for testing commit logic.
 */
function createMockState(
	partitionSessions: Map<bigint, TopicPartitionSession>
): TopicReaderState {
	return {
		disposed: false,
		pendingCommits: new Map(),
		partitionSessions,
		outgoingQueue: new AsyncPriorityQueue(),
		// Unused in _commit, but required by type
		options: { topic: 'test', consumer: 'test' },
		driver: {} as any,
		topicsReadSettings: [],
		controller: new AbortController(),
		buffer: [],
		codecs: new Map(),
		maxBufferSize: 0n,
		freeBufferSize: 0n,
	}
}

/**
 * Creates a TopicMessage for testing.
 */
function createMessage(
	partitionSession: TopicPartitionSession,
	offset: bigint
): TopicMessage {
	return new TopicMessage({
		partitionSession,
		producer: 'test-producer',
		payload: new Uint8Array(),
		codec: Codec.RAW,
		seqNo: 1n,
		offset,
	})
}

// https://github.com/ydb-platform/ydb-js-sdk/issues/552
// When messages are deleted by retention policy, there's a gap between
// committedOffset (e.g., 0) and the first available message offset (e.g., 29).
// The SDK must fill this gap by using nextCommitStartOffset as the range start.
test('fills gap between committedOffset and first message offset', async () => {
	let partitionSession = new TopicPartitionSession(1n, 0n, '/test/topic')

	// Simulate: server returned committedOffset=0, but first message has offset=29
	// (messages 0-28 were deleted by retention policy)
	partitionSession.nextCommitStartOffset = 0n

	let partitionSessions = new Map([[1n, partitionSession]])
	let state = createMockState(partitionSessions)

	let message = createMessage(partitionSession, 29n)

	// Start commit (don't await - we just check the outgoing request)
	_commit(state, message)

	// Check that outgoing queue has the commit request with gap filled
	let request = await state.outgoingQueue[Symbol.asyncIterator]().next()
	let commitRequest = request.value?.clientMessage

	assert.strictEqual(commitRequest?.case, 'commitOffsetRequest')
	if (commitRequest?.case === 'commitOffsetRequest') {
		let offsets = commitRequest.value.commitOffsets[0]?.offsets[0]
		// Gap should be filled: start=0 (not 29), end=30
		assert.strictEqual(offsets?.start, 0n)
		assert.strictEqual(offsets?.end, 30n)
	}

	// nextCommitStartOffset should be updated for subsequent commits
	assert.strictEqual(partitionSession.nextCommitStartOffset, 30n)
})

// https://github.com/ydb-platform/ydb-js-sdk/issues/552
// After committing, nextCommitStartOffset must be updated so subsequent
// commits don't re-fill the same gap.
test('updates nextCommitStartOffset after commit', async () => {
	let partitionSession = new TopicPartitionSession(1n, 0n, '/test/topic')
	partitionSession.nextCommitStartOffset = 50n

	let partitionSessions = new Map([[1n, partitionSession]])
	let state = createMockState(partitionSessions)

	let message = createMessage(partitionSession, 50n)
	_commit(state, message)

	assert.strictEqual(partitionSession.nextCommitStartOffset, 51n)

	// Second commit should use updated nextCommitStartOffset
	let message2 = createMessage(partitionSession, 51n)
	_commit(state, message2)

	assert.strictEqual(partitionSession.nextCommitStartOffset, 52n)
})
