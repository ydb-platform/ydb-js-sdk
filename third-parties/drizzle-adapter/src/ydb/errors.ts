import { DrizzleQueryError } from 'drizzle-orm/errors'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'

export type YdbQueryErrorKind =
	| 'authentication'
	| 'cancelled'
	| 'overloaded'
	| 'retryable'
	| 'timeout'
	| 'unavailable'
	| 'unique_constraint'

export interface YdbQueryErrorDetails {
	kind: YdbQueryErrorKind
	retryable: boolean
	statusCode?: number | string | undefined
}

type YdbErrorDiagnostics = {
	messages: string[]
	statusCodes: Set<number | string>
	retryable?: boolean
}

const grpcStatus = {
	CANCELLED: 1,
	DEADLINE_EXCEEDED: 4,
	PERMISSION_DENIED: 7,
	RESOURCE_EXHAUSTED: 8,
	UNAVAILABLE: 14,
	UNAUTHENTICATED: 16,
} as const

const retryableYdbStatusCodes = new Set<number>([
	StatusIds_StatusCode.ABORTED,
	StatusIds_StatusCode.INTERNAL_ERROR,
	StatusIds_StatusCode.UNAVAILABLE,
	StatusIds_StatusCode.OVERLOADED,
	StatusIds_StatusCode.TIMEOUT,
	StatusIds_StatusCode.BAD_SESSION,
	StatusIds_StatusCode.SESSION_EXPIRED,
	StatusIds_StatusCode.UNDETERMINED,
	StatusIds_StatusCode.SESSION_BUSY,
	StatusIds_StatusCode.EXTERNAL_ERROR,
])

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause))
}

function collectDiagnostics(
	value: unknown,
	diagnostics: YdbErrorDiagnostics,
	seen = new Set<unknown>()
): void {
	if (!value || seen.has(value)) {
		return
	}
	seen.add(value)

	if (value instanceof Error) {
		diagnostics.messages.push(value.name, value.message)
		let record = value as unknown as Record<string, unknown>
		for (let key of ['reason', 'code', 'status', 'statusCode']) {
			let field = record[key]
			if (typeof field === 'string' || typeof field === 'number') {
				diagnostics.messages.push(String(field))
				if (key !== 'reason') {
					diagnostics.statusCodes.add(field)
				}
			}
		}
		if (typeof record['retryable'] === 'boolean') {
			diagnostics.retryable = record['retryable']
		}
		for (let key of ['issues', 'cause']) {
			collectDiagnostics(record[key], diagnostics, seen)
		}
		return
	}

	if (Array.isArray(value)) {
		for (let item of value) {
			collectDiagnostics(item, diagnostics, seen)
		}
		return
	}

	if (typeof value !== 'object') {
		diagnostics.messages.push(String(value))
		return
	}

	let record = value as Record<string, unknown>
	for (let key of ['name', 'message', 'reason', 'code', 'status', 'statusCode']) {
		let field = record[key]
		if (typeof field === 'string' || typeof field === 'number') {
			diagnostics.messages.push(String(field))
			if (key !== 'name' && key !== 'message' && key !== 'reason') {
				diagnostics.statusCodes.add(field)
			}
		}
	}

	if (typeof record['retryable'] === 'boolean') {
		diagnostics.retryable = record['retryable']
	}

	for (let key of ['issues', 'cause']) {
		collectDiagnostics(record[key], diagnostics, seen)
	}
}

function getDiagnostics(error: unknown): YdbErrorDiagnostics {
	let diagnostics: YdbErrorDiagnostics = {
		messages: [],
		statusCodes: new Set(),
	}
	collectDiagnostics(error, diagnostics)
	return diagnostics
}

function hasStatus(diagnostics: YdbErrorDiagnostics, ...codes: Array<number | string>): boolean {
	for (let code of codes) {
		if (diagnostics.statusCodes.has(code)) {
			return true
		}
		if (typeof code === 'string' && diagnostics.statusCodes.has(code.toUpperCase())) {
			return true
		}
	}
	return false
}

function getStatusCode(diagnostics: YdbErrorDiagnostics): number | string | undefined {
	return diagnostics.statusCodes.values().next().value
}

function getDiagnosticText(diagnostics: YdbErrorDiagnostics): string {
	return diagnostics.messages.join('\n')
}

function isUniqueConstraintError(diagnostics: YdbErrorDiagnostics): boolean {
	let text = getDiagnosticText(diagnostics)
	return (
		/(unique|constraint).*(violation|violated|duplicate|already exists|conflict)/iu.test(
			text
		) || /(duplicate|already exists|conflict).*(key|unique|constraint)/iu.test(text)
	)
}

function classifyYdbQueryError(diagnostics: YdbErrorDiagnostics): YdbQueryErrorDetails | undefined {
	if (isUniqueConstraintError(diagnostics)) {
		return {
			kind: 'unique_constraint',
			retryable: false,
			statusCode: getStatusCode(diagnostics),
		}
	}

	let text = getDiagnosticText(diagnostics)
	let statusCode = getStatusCode(diagnostics)

	if (
		hasStatus(
			diagnostics,
			StatusIds_StatusCode.UNAUTHORIZED,
			grpcStatus.UNAUTHENTICATED,
			grpcStatus.PERMISSION_DENIED,
			'UNAUTHORIZED',
			'UNAUTHENTICATED',
			'PERMISSION_DENIED'
		) ||
		/(unauthorized|unauthenticated|permission denied|access denied|invalid token)/iu.test(text)
	) {
		return { kind: 'authentication', retryable: false, statusCode }
	}

	if (
		hasStatus(
			diagnostics,
			StatusIds_StatusCode.CANCELLED,
			grpcStatus.CANCELLED,
			'CANCELLED',
			'CANCELED'
		) ||
		/\bcancell?ed\b/iu.test(text)
	) {
		return { kind: 'cancelled', retryable: diagnostics.retryable === true, statusCode }
	}

	if (
		hasStatus(
			diagnostics,
			StatusIds_StatusCode.TIMEOUT,
			grpcStatus.DEADLINE_EXCEEDED,
			'TIMEOUT',
			'DEADLINE_EXCEEDED'
		) ||
		/(timeout|deadline exceeded|timed out)/iu.test(text)
	) {
		return { kind: 'timeout', retryable: true, statusCode }
	}

	if (
		hasStatus(
			diagnostics,
			StatusIds_StatusCode.OVERLOADED,
			grpcStatus.RESOURCE_EXHAUSTED,
			'OVERLOADED',
			'RESOURCE_EXHAUSTED'
		) ||
		/(overloaded|resource exhausted|too many requests|throttl)/iu.test(text)
	) {
		return { kind: 'overloaded', retryable: true, statusCode }
	}

	if (
		hasStatus(
			diagnostics,
			StatusIds_StatusCode.UNAVAILABLE,
			grpcStatus.UNAVAILABLE,
			'UNAVAILABLE'
		) ||
		/(unavailable|connection refused|connection reset|transport.*closed|no connection)/iu.test(
			text
		)
	) {
		return { kind: 'unavailable', retryable: true, statusCode }
	}

	for (let code of diagnostics.statusCodes) {
		if (typeof code === 'number' && retryableYdbStatusCodes.has(code)) {
			return { kind: 'retryable', retryable: true, statusCode }
		}
	}

	if (diagnostics.retryable === true) {
		return { kind: 'retryable', retryable: true, statusCode }
	}

	return undefined
}

function attachYdbErrorDetails<T extends DrizzleQueryError>(
	target: T,
	cause: unknown,
	details?: YdbQueryErrorDetails
): T {
	if (cause && typeof cause === 'object') {
		let record = cause as Record<string, unknown>
		for (let key of ['code', 'status', 'statusCode', 'issues', 'retryable']) {
			if (key in record) {
				Object.defineProperty(target, key, {
					configurable: true,
					enumerable: false,
					value: record[key],
				})
			}
		}
	}

	if (details) {
		Object.defineProperties(target, {
			kind: {
				configurable: true,
				enumerable: false,
				value: details.kind,
			},
			retryable: {
				configurable: true,
				enumerable: false,
				value: details.retryable,
			},
			statusCode: {
				configurable: true,
				enumerable: false,
				value: details.statusCode,
			},
		})
	}

	return target
}

export class YdbQueryExecutionError extends DrizzleQueryError {
	override name = 'YdbQueryExecutionError'
	declare readonly kind: YdbQueryErrorKind
	declare readonly retryable: boolean
	declare readonly statusCode?: number | string
}

export class YdbUniqueConstraintViolationError extends YdbQueryExecutionError {
	override name = 'YdbUniqueConstraintViolationError'
}

export class YdbAuthenticationError extends YdbQueryExecutionError {
	override name = 'YdbAuthenticationError'
}

export class YdbCancelledQueryError extends YdbQueryExecutionError {
	override name = 'YdbCancelledQueryError'
}

export class YdbRetryableQueryError extends YdbQueryExecutionError {
	override name = 'YdbRetryableQueryError'
}

export class YdbTimeoutQueryError extends YdbRetryableQueryError {
	override name = 'YdbTimeoutQueryError'
}

export class YdbUnavailableQueryError extends YdbRetryableQueryError {
	override name = 'YdbUnavailableQueryError'
}

export class YdbOverloadedQueryError extends YdbRetryableQueryError {
	override name = 'YdbOverloadedQueryError'
}

function createMappedError(
	query: string,
	params: unknown[],
	cause: Error,
	details: YdbQueryErrorDetails
): YdbQueryExecutionError {
	switch (details.kind) {
		case 'unique_constraint':
			return new YdbUniqueConstraintViolationError(query, params, cause)
		case 'authentication':
			return new YdbAuthenticationError(query, params, cause)
		case 'cancelled':
			return new YdbCancelledQueryError(query, params, cause)
		case 'timeout':
			return new YdbTimeoutQueryError(query, params, cause)
		case 'unavailable':
			return new YdbUnavailableQueryError(query, params, cause)
		case 'overloaded':
			return new YdbOverloadedQueryError(query, params, cause)
		case 'retryable':
			return new YdbRetryableQueryError(query, params, cause)
	}
}

export function mapYdbQueryError(
	query: string,
	params: unknown[],
	cause: unknown
): DrizzleQueryError {
	let error = toError(cause)
	let diagnostics = getDiagnostics(cause)
	collectDiagnostics(error, diagnostics)
	let details = classifyYdbQueryError(diagnostics)

	if (details) {
		return attachYdbErrorDetails(
			createMappedError(query, params, error, details),
			cause,
			details
		)
	}

	return attachYdbErrorDetails(new DrizzleQueryError(query, params, error), cause)
}
