import { StatusIds_StatusCode, type IssueMessage } from '@ydbjs/api/operation'
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

	get retryable(): boolean | 'conditionally' {
		if ([
			StatusIds_StatusCode.ABORTED,
			StatusIds_StatusCode.OVERLOADED,
			StatusIds_StatusCode.UNAVAILABLE,
			StatusIds_StatusCode.BAD_SESSION,
			StatusIds_StatusCode.SESSION_BUSY,
		].includes(this.code)) {
			return true
		}

		if ([
			StatusIds_StatusCode.SESSION_EXPIRED,
			StatusIds_StatusCode.UNDETERMINED,
			StatusIds_StatusCode.TIMEOUT
		].includes(this.code)) {
			return 'conditionally'
		}

		return false
	}
}

export class CommitError extends ExtendableError {
	constructor(message: string, public override cause?: unknown) {
		super(message)
		this.name = 'CommitError'
	}

	retryable(idempotent: boolean = false): boolean {
		return (this.cause instanceof YDBError && this.cause.retryable === true)
			|| (this.cause instanceof YDBError && this.cause.retryable === "conditionally" && idempotent)
	}
}
