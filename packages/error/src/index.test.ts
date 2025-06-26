import { expect, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import { IssueMessageSchema, StatusIds_StatusCode } from '@ydbjs/api/operation'
import { CommitError, YDBError } from './index.ts'

test('handles single issue', () => {
	let error = new YDBError(StatusIds_StatusCode.ABORTED, [
		create(IssueMessageSchema, {
			severity: 1,
			issueCode: 1030,
			message: 'Type annotation',
			issues: [
				create(IssueMessageSchema, {
					severity: 1,
					issueCode: 0,
					message: 'At function: KiWriteTable!',
					issues: [
						create(IssueMessageSchema, {
							severity: 0,
							issueCode: 1,
							message: `Failed to convert type: Struct<'created_at':Int32> to Struct<'created_at':Uint32>`,
						}),
						create(IssueMessageSchema, {
							severity: 0,
							issueCode: 2031,
							message: `Failed to convert input columns types to scheme types`,
						}),
					],
				}),
			],
		}),
	])

	expect(error.code).eq(StatusIds_StatusCode.ABORTED)
	expect(error.message).eq('ABORTED, Issues: ERROR(1030): Type annotation')
})

test('handles multiple issues', () => {
	let error = new YDBError(StatusIds_StatusCode.ABORTED, [
		create(IssueMessageSchema, {
			severity: 0,
			issueCode: 14,
			message: 'Some error message',
		}),
		create(IssueMessageSchema, {
			severity: 1,
			issueCode: 15,
			message: 'Another error message',
		}),
	])

	expect(error.code).eq(StatusIds_StatusCode.ABORTED)
	expect(error.message).eq('ABORTED, Issues: FATAL(14): Some error message; ERROR(15): Another error message')
})

test('creates commit error', () => {
	let error = new CommitError('Commit failed', new YDBError(StatusIds_StatusCode.ABORTED, []))

	expect(error.message).eq('Commit failed')
})
