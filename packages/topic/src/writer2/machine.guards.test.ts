import { expect, test } from 'vitest'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { WriterMachine } from './machine.ts'
import type { WriterContext } from './types.ts'

test.each([
	[true, 'buffer >= max and inflight < max', 100n, 1],
	[false, 'buffer >= max and inflight > max', 100n, 5],
	[false, 'buffer < max and inflight < max', 99n, 1],
	[false, 'buffer < max and inflight > max', 99n, 5],
])(
	`bufferFullAndCanSend returns %o when %s`,
	(expected, _, bufferSize, inflightLength) => {
		let bufferFullAndCanSend =
			WriterMachine.implementations.guards.bufferFullAndCanSend!

		let context = {
			options: {
				maxBufferBytes: 100n,
				maxInflightCount: 5,
			},
			bufferSize,
			inflightLength,
		} as unknown as WriterContext

		expect(bufferFullAndCanSend({ context, event: {} as any }, {})).toBe(
			expected
		)
	}
)

test.each([
	[true, 'buffer > 0 and inflight < max', 1, 1],
	[false, 'buffer > 0 and inflight > max', 1, 5],
	[false, 'buffer = 0 and inflight < max', 0, 1],
	[false, 'buffer = 0 and inflight > max', 0, 5],
])(
	'hasMessagesAndCanSend returns %o when %s',
	(expected, _, bufferLength, inflightLength) => {
		let hasMessagesAndCanSend =
			WriterMachine.implementations.guards.hasMessagesAndCanSend!

		let context = {
			options: { maxInflightCount: 5 },
			bufferLength,
			inflightLength,
		} as unknown as WriterContext

		expect(hasMessagesAndCanSend({ context, event: {} as any }, {})).toBe(
			expected
		)
	}
)

test.each([
	[true, 'retryable', StatusIds_StatusCode.OVERLOADED],
	[false, 'non-retryable', StatusIds_StatusCode.NOT_FOUND],
])(
	'retryableError returns %o when lastError is %s',
	(expected, _, lastError) => {
		let retryableError =
			WriterMachine.implementations.guards.retryableError!

		let context = {
			lastError: new YDBError(lastError, []),
		} as unknown as WriterContext

		expect(retryableError({ context, event: {} as any }, {})).toBe(expected)
	}
)

test.each([
	[true, 'non-retryable', StatusIds_StatusCode.NOT_FOUND],
	[false, 'retryable', StatusIds_StatusCode.OVERLOADED],
])(
	'nonRetryableError returns %o when lastError is %s',
	(expected, _, lastError) => {
		let nonRetryableError =
			WriterMachine.implementations.guards.nonRetryableError!

		let context = {
			lastError: new YDBError(lastError, []),
		} as unknown as WriterContext

		expect(nonRetryableError({ context, event: {} as any }, {})).toBe(
			expected
		)
	}
)

test.each([
	[true, 'buffer = 0 and inflight = 0', 0, 0],
	[false, 'buffer > 0 and inflight = 0', 1, 0],
	[false, 'buffer = 0 and inflight > 0', 0, 1],
])(
	'allMessagesSent returns %o when %s',
	(expected, _, bufferLength, inflightLength) => {
		let allMessagesSent =
			WriterMachine.implementations.guards.allMessagesSent!

		let context = {
			bufferLength,
			inflightLength,
		} as unknown as WriterContext

		expect(allMessagesSent({ context, event: {} as any }, {})).toBe(
			expected
		)
	}
)

test.each([
	[true, 'garbage > max', 101, 0],
	[true, 'garbage < max  and size > max', 1, 2048],
	[false, 'garbage < max and size < max', 1, 0],
])(
	'shouldReclaimMemory returns %o when %s',
	(expected, _, inflightStart, garbageSize) => {
		let shouldReclaimMemory =
			WriterMachine.implementations.guards.shouldReclaimMemory!

		let context = {
			options: {
				garbageCollection: {
					maxGarbageCount: 100,
					maxGarbageSize: 1024,
				},
			},
			inflightStart,
			garbageSize,
		} as unknown as WriterContext

		expect(shouldReclaimMemory({ context, event: {} as any }, {})).toBe(
			expected
		)
	}
)
