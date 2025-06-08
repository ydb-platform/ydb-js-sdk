import { type MessageJsonType, toJson } from '@bufbuild/protobuf'
import { type IssueMessage, IssueMessageSchema, StatusIds_StatusCode } from '@ydbjs/api/operation'

export class YDBIssue {
	constructor(
		public code: number,
		public message: string,
		public severity: number,
		public issues: YDBIssue[] = []
	) { }

	static severity: Record<IssueMessage['severity'], string> = {
		0: "FATAL",
		1: "ERROR",
		2: "WARNING",
		3: "INFO",
	} as const

	static fromIssueMessage(issue: IssueMessage): YDBIssue {
		return new YDBIssue(
			issue.issueCode,
			issue.message,
			issue.severity,
			issue.issues.map(YDBIssue.fromIssueMessage)
		)
	}

	toString(): string {
		return `${YDBIssue.severity[this.severity]}(${this.code}): ${this.message}`
	}

	[Symbol.toStringTag]() {
		return this.toString()
	}
}

export class YDBError extends Error {
	readonly code: StatusIds_StatusCode
	readonly issues: MessageJsonType<typeof IssueMessageSchema>[]

	constructor(code: StatusIds_StatusCode, issues: IssueMessage[]) {
		super(`${YDBError.codes[code]}` + (issues.length ? `, Issues: ${issues.map(YDBIssue.fromIssueMessage).join('; ')}` : ''))
		this.code = code
		this.issues = issues.map((issue) => toJson(IssueMessageSchema, issue as IssueMessage))
	}

	static codes: Record<StatusIds_StatusCode, string> = {
		[StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED]: "UNSPECIFIED",
		[StatusIds_StatusCode.SUCCESS]: "SUCCESS",
		[StatusIds_StatusCode.BAD_REQUEST]: "BAD_REQUEST",
		[StatusIds_StatusCode.UNAUTHORIZED]: "UNAUTHORIZED",
		[StatusIds_StatusCode.INTERNAL_ERROR]: "INTERNAL_ERROR",
		[StatusIds_StatusCode.ABORTED]: "ABORTED",
		[StatusIds_StatusCode.UNAVAILABLE]: "UNAVAILABLE",
		[StatusIds_StatusCode.OVERLOADED]: "OVERLOADED",
		[StatusIds_StatusCode.SCHEME_ERROR]: "SCHEME_ERROR",
		[StatusIds_StatusCode.GENERIC_ERROR]: "GENERIC_ERROR",
		[StatusIds_StatusCode.TIMEOUT]: "TIMEOUT",
		[StatusIds_StatusCode.BAD_SESSION]: "BAD_SESSION",
		[StatusIds_StatusCode.PRECONDITION_FAILED]: "PRECONDITION_FAILED",
		[StatusIds_StatusCode.ALREADY_EXISTS]: "ALREADY_EXISTS",
		[StatusIds_StatusCode.NOT_FOUND]: "NOT_FOUND",
		[StatusIds_StatusCode.SESSION_EXPIRED]: "SESSION_EXPIRED",
		[StatusIds_StatusCode.CANCELLED]: "CANCELLED",
		[StatusIds_StatusCode.UNDETERMINED]: "UNDETERMINED",
		[StatusIds_StatusCode.UNSUPPORTED]: "UNSUPPORTED",
		[StatusIds_StatusCode.SESSION_BUSY]: "SESSION_BUSY",
		[StatusIds_StatusCode.EXTERNAL_ERROR]: "EXTERNAL_ERROR"
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

export class CommitError extends Error {
	constructor(message: string, public override cause?: unknown) {
		super(message)
	}

	retryable(idempotent: boolean = false): boolean {
		return (this.cause instanceof YDBError && this.cause.retryable === true)
			|| (this.cause instanceof YDBError && this.cause.retryable === "conditionally" && idempotent)
	}
}
