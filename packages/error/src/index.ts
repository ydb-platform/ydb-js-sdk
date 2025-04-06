import type { IssueMessage, StatusIds_StatusCode } from '@ydbjs/api/operation'
import { ExtendableError } from 'ts-error'

export class YDBError extends ExtendableError {
	code: StatusIds_StatusCode

	constructor(code: StatusIds_StatusCode, issues: Pick<IssueMessage, 'severity' | 'issueCode' | 'message'>[]) {
		super(`Status: ${code}, Issues: ` + issues.map((issue) => `${YDBError.severity[issue.severity] || "UNKNOWN"} ${issue.issueCode}: ${issue.message}`).join('; '))
		this.code = code
	}

	static severity: Record<number, string> = {
		0: "FATAL",
		1: "ERROR",
		2: "WARNING",
		3: "INFO",
	} as const
}
