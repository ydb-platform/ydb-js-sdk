import { expect, test } from 'vitest'

import { ClientError, Status } from 'nice-grpc'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'

import { BASE_ATTRIBUTES, recordErrorAttributes } from './common.ts'

test('exposes only db.system.name on BASE_ATTRIBUTES', () => {
	expect(BASE_ATTRIBUTES['db.system.name']).toBe('ydb')
	expect(BASE_ATTRIBUTES['server.address']).toBeUndefined()
})

test('marks YDBError as ydb_error and carries the status code', () => {
	let attrs = recordErrorAttributes(new YDBError(StatusIds_StatusCode.ABORTED, []))
	expect(attrs['db.response.status_code']).toBe('ABORTED')
	expect(attrs['error.type']).toBe('ydb_error')
})

test('marks ClientError as transport_error without a status code', () => {
	let attrs = recordErrorAttributes(new ClientError('p', Status.UNAVAILABLE, 'down'))
	expect(attrs['db.response.status_code']).toBeUndefined()
	expect(attrs['error.type']).toBe('transport_error')
})

test('returns AbortError as error.type for cancellations', () => {
	let e = new Error('aborted')
	e.name = 'AbortError'
	expect(recordErrorAttributes(e)['error.type']).toBe('AbortError')
})

test('returns TimeoutError as error.type for timeouts', () => {
	let e = new Error('timed out')
	e.name = 'TimeoutError'
	expect(recordErrorAttributes(e)['error.type']).toBe('TimeoutError')
})

test('falls back to Error / unknown for plain Error and non-Error throws', () => {
	expect(recordErrorAttributes(new Error('whatever'))['error.type']).toBe('Error')
	expect(recordErrorAttributes('string')['error.type']).toBe('unknown')
	expect(recordErrorAttributes(null)['error.type']).toBe('unknown')
})
