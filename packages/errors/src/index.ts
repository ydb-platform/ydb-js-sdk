import type { IssueMessage, StatusIds_StatusCode } from '@ydbjs/api/operation'
import { ExtendableError } from 'ts-error'

export class YDBError extends ExtendableError {
	code: StatusIds_StatusCode

	constructor(code: StatusIds_StatusCode, issues: IssueMessage[]) {
		super(issues.map((issue) => `${issue.issueCode}: ${issue.message}`).join(', '))
		this.code = code
	}
}
