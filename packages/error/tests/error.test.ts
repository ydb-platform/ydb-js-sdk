import { expect, test } from 'vitest'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'

test('single issue', () => {
	let error = new YDBError(StatusIds_StatusCode.ABORTED, [
		{
			severity: 0,
			issueCode: 14,
			message: 'Some error message',
		},
	])

	expect(error.code).eq(StatusIds_StatusCode.ABORTED)
	expect(error.message).eq('Status: 400040, Issues: FATAL 14: Some error message')
})

test('multiple issues', () => {
	let error = new YDBError(StatusIds_StatusCode.ABORTED, [
		{
			severity: 0,
			issueCode: 14,
			message: 'Some error message',
		},
		{
			severity: 1,
			issueCode: 15,
			message: 'Another error message',
		},
	])

	expect(error.code).eq(StatusIds_StatusCode.ABORTED)
	expect(error.message).eq('Status: 400040, Issues: FATAL 14: Some error message; ERROR 15: Another error message')
})
