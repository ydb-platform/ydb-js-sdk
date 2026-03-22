import { expect, test } from 'vitest'
import { ClientError, Status } from 'nice-grpc'
import { recordErrorAttributes } from '@ydbjs/telemetry'

test('recordErrorAttributes maps nice-grpc ClientError to gRPC status name', () => {
	const error = new ClientError(
		'/Ydb.Query.V1.QueryService/ExecuteQuery',
		Status.UNAVAILABLE,
		'connection refused'
	)
	const attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('UNAVAILABLE')
	expect(attrs['error.type']).toBe('UNAVAILABLE')
})

test('recordErrorAttributes maps ClientError DEADLINE_EXCEEDED', () => {
	const error = new ClientError(
		'/Ydb.Query.V1.QueryService/CreateSession',
		Status.DEADLINE_EXCEEDED,
		'deadline'
	)
	const attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('DEADLINE_EXCEEDED')
	expect(attrs['error.type']).toBe('DEADLINE_EXCEEDED')
})
