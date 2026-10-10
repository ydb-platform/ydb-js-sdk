import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'
import { expect, test } from 'vitest'

import { isPartitionRevokedError } from './topic-errors.ts'

let revoked = () => new Error('Cannot commit a message from a stopped or expired partition session')

let messages = [
	'Cannot commit a message from a stopped or expired partition session',
	'Cannot commit offsets for a stopped or expired partition session (partition /local/topic|2)',
	'Partition /local/topic|2 reassigned before commit was acknowledged',
	'No active partition /local/topic|2 to commit',
]

test.each(messages)('recognizes the local reader error: %s', (message) => {
	expect(isPartitionRevokedError(new Error(message))).toBe(true)
})

test('recognizes nested aggregates only when every leaf is a revocation error', () => {
	let error = new AggregateError(
		[
			revoked(),
			new AggregateError(
				messages.map((message) => new Error(message)),
				'commit batch'
			),
		],
		'Cannot commit one or more partitions'
	)
	expect(isPartitionRevokedError(error)).toBe(true)
})

let fatal = [
	{ name: 'authorization', error: new YDBError(StatusIds_StatusCode.UNAUTHORIZED, []) },
	{
		name: 'transport',
		error: new ClientError('/Ydb.Topic/StreamRead', Status.UNAVAILABLE, messages[0]!),
	},
	{ name: 'codec', error: new Error('Unsupported codec: 999') },
	{ name: 'unknown', error: new Error('Reader stopped unexpectedly') },
]

test.each(fatal)('rejects a mixed aggregate containing a $name failure', ({ error }) => {
	expect(isPartitionRevokedError(error)).toBe(false)
	expect(
		isPartitionRevokedError(
			new AggregateError([revoked(), new AggregateError([revoked(), error])], messages[0]!)
		)
	).toBe(false)
})

test('rejects empty aggregates at any depth', () => {
	expect(isPartitionRevokedError(new AggregateError([], messages[0]!))).toBe(false)
	expect(isPartitionRevokedError(new AggregateError([revoked(), new AggregateError([])]))).toBe(
		false
	)
})

test('does not infer revocation from arbitrary messages or error causes', () => {
	for (let error of [
		undefined,
		null,
		messages[0],
		{ message: messages[0] },
		new Error('Connection stopped while committing'),
		new Error(`UNAUTHORIZED: ${messages[0]}`),
		new Error('Commit failed', { cause: revoked() }),
	]) {
		expect(isPartitionRevokedError(error)).toBe(false)
	}
})
