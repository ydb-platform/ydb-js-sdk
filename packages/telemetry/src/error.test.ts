import { expect, test } from 'vitest'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'

import { recordErrorAttributes } from './tracing.js'

test('recordErrorAttributes returns status and type for YDBError', () => {
	let error = new YDBError(StatusIds_StatusCode.ABORTED, [])
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('ABORTED')
	expect(attrs['error.type']).toBe('ABORTED')
})

test('recordErrorAttributes maps YDBError TIMEOUT code', () => {
	let error = new YDBError(StatusIds_StatusCode.TIMEOUT, [])
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TIMEOUT')
	expect(attrs['error.type']).toBe('TIMEOUT')
})

test('recordErrorAttributes maps YDBError CANCELLED code', () => {
	let error = new YDBError(StatusIds_StatusCode.CANCELLED, [])
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('CANCELLED')
	expect(attrs['error.type']).toBe('CANCELLED')
})

test('recordErrorAttributes returns CANCELLED for AbortError', () => {
	let error = new Error('aborted')
	error.name = 'AbortError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('CANCELLED')
	expect(attrs['error.type']).toBe('CANCELLED')
})

test('recordErrorAttributes returns CANCELLED for error with Abort in name', () => {
	let error = new Error('aborted')
	error.name = 'CustomAbortSomething'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('CANCELLED')
	expect(attrs['error.type']).toBe('CANCELLED')
})

test('recordErrorAttributes returns TIMEOUT for TimeoutError', () => {
	let error = new Error('timed out')
	error.name = 'TimeoutError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TIMEOUT')
	expect(attrs['error.type']).toBe('TIMEOUT')
})

test('recordErrorAttributes returns TIMEOUT for error with Timeout in name', () => {
	let error = new Error('timed out')
	error.name = 'RequestTimeoutError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TIMEOUT')
	expect(attrs['error.type']).toBe('TIMEOUT')
})

test('recordErrorAttributes returns TRANSPORT_ERROR for ClientError', () => {
	let error = new Error('connection failed')
	error.name = 'ClientError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TRANSPORT_ERROR')
	expect(attrs['error.type']).toBe('TRANSPORT_ERROR')
})

test('recordErrorAttributes returns UNKNOWN for generic Error', () => {
	let error = new Error('something went wrong')
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('UNKNOWN')
	expect(attrs['error.type']).toBe('UNKNOWN')
})

test('recordErrorAttributes returns UNKNOWN for non-Error value', () => {
	let attrs = recordErrorAttributes('string error')
	expect(attrs['db.response.status_code']).toBe('UNKNOWN')
	expect(attrs['error.type']).toBe('UNKNOWN')
})

test('recordErrorAttributes returns UNKNOWN for null', () => {
	let attrs = recordErrorAttributes(null)
	expect(attrs['db.response.status_code']).toBe('UNKNOWN')
	expect(attrs['error.type']).toBe('UNKNOWN')
})
