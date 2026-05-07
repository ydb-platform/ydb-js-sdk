import { expect, test } from 'vitest'
import type { Codec } from '@ydbjs/api/topic'
import { TopicMessage } from './message.js'
import { TopicPartitionSession } from './partition-session.js'

test('keeps createdAt writtenAt and metadataItems from constructor options', () => {
	let metadataItems = {
		traceId: new Uint8Array([1, 2, 3]),
		spanId: new Uint8Array([4, 5, 6]),
	}

	let message = new TopicMessage({
		partitionSession: new TopicPartitionSession(1n, 1n, '/test'),
		producer: 'test-producer',
		payload: new Uint8Array([42]),
		codec: 1 as Codec,
		seqNo: 1n,
		createdAt: 1_700_000_000_000,
		writtenAt: 1_700_000_100_000,
		metadataItems,
	})

	expect(message.createdAt).toBe(1_700_000_000_000)
	expect(message.writtenAt).toBe(1_700_000_100_000)
	expect(message.metadataItems).toBe(metadataItems)
	expect(message.metadataItems).toEqual({
		traceId: new Uint8Array([1, 2, 3]),
		spanId: new Uint8Array([4, 5, 6]),
	})
})
