import { expect, test } from 'vitest'

import { create } from '@bufbuild/protobuf'
import { IssueMessageSchema, StatusIds_StatusCode } from '@ydbjs/api/operation'
import { CommitError, YDBError, YDBIssue } from './index.ts'

test('maps code, message, severity and nested issues from a protobuf issue message', () => {
	let issue = YDBIssue.fromIssueMessage(
		create(IssueMessageSchema, {
			severity: 1,
			issueCode: 1030,
			message: 'Type annotation',
			issues: [
				create(IssueMessageSchema, {
					severity: 0,
					issueCode: 2031,
					message: 'Failed to convert input columns types to scheme types',
				}),
			],
		})
	)

	expect(issue.code).eq(1030)
	expect(issue.message).eq('Type annotation')
	expect(issue.severity).eq(1)
	expect(issue.issues).toHaveLength(1)
	expect(issue.issues[0]?.code).eq(2031)
	expect(issue.issues[0]?.message).eq('Failed to convert input columns types to scheme types')
	expect(issue.issues[0]?.severity).eq(0)
})

test('formats as "SEVERITY(code): message"', () => {
	let issue = new YDBIssue(1030, 'Type annotation', 1)

	expect(issue.toString()).eq('ERROR(1030): Type annotation')
})

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
	expect(error.message).eq(
		'ABORTED, Issues: FATAL(14): Some error message; ERROR(15): Another error message'
	)
})

test('creates commit error', () => {
	let cause = new YDBError(StatusIds_StatusCode.ABORTED, [])
	let error = new CommitError('Commit failed', cause)

	expect(error.message).eq('Commit failed')
	expect(error.cause).toBe(cause)
})

test('is retryable when the cause is a retryable YDBError', () => {
	let error = new CommitError('Commit failed', new YDBError(StatusIds_StatusCode.ABORTED, []))

	expect(error.retryable()).toBe(true)
})

test('is retryable only when idempotent, for a conditionally-retryable cause', () => {
	let error = new CommitError('Commit failed', new YDBError(StatusIds_StatusCode.TIMEOUT, []))

	expect(error.retryable()).toBe(false)
	expect(error.retryable(true)).toBe(true)
})

test('is not retryable when the cause is not a YDBError', () => {
	let error = new CommitError('Commit failed', new Error('boom'))

	expect(error.retryable()).toBe(false)
})
