import type { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'

export const SpanKind = {
	CLIENT: 1,
} as const

export type SpanContext = {
	traceId: string
	spanId: string
	traceFlags: number
}

export type Span = {
	/**
	 * Returns W3C traceparent string (e.g. "00-<traceId>-<spanId>-<flags>") for propagation.
	 * Empty string for no-op spans.
	 */
	getId(): string
	spanContext(): SpanContext
	setAttribute(key: string, value: string | number | boolean): void
	setAttributes(attrs: Record<string, string | number | boolean>): void
	end(): void
	recordException(error: Error): void
	setStatus(status: { code: number; message?: string }): void
}

export type StartSpanOptions = {
	kind?: (typeof SpanKind)[keyof typeof SpanKind]
	attributes?: Record<string, string | number | boolean>
}

export type Tracer = {
	startSpan(name: string, options?: StartSpanOptions): Span
}

class NoopSpan implements Span {
	getId(): string {
		return ''
	}
	spanContext(): SpanContext {
		return { traceId: '', spanId: '', traceFlags: 0 }
	}
	setAttribute(_key: string, _value: string | number | boolean): void {}
	setAttributes(_attrs: Record<string, string | number | boolean>): void {}
	end(): void {}
	recordException(_error: Error): void {}
	setStatus(_status: { code: number; message?: string }): void {}
}

export const NoopTracer: Tracer = {
	startSpan(_name: string, _options?: StartSpanOptions): Span {
		return new NoopSpan()
	},
}

export const DB_SYSTEM = 'ydb'

export const SPAN_NAMES = {
	CreateSession: 'ydb.CreateSession',
	ExecuteQuery: 'ydb.ExecuteQuery',
	Commit: 'ydb.Commit',
	Rollback: 'ydb.Rollback',
} as const

export type SpanBaseAttributes = {
	'server.address': string
	'server.port': number
	'network.peer.address': string
	'network.peer.port': number
	'db.namespace'?: string
	'ydb.node.id'?: number
	'ydb.node.dc'?: string
}

export type GetBaseAttributesOptions = {
	dbNamespace?: string
	peerAddress?: string
	peerPort?: number
	nodeId?: number
	nodeDc?: string
}

export function getBaseAttributes(
	serverAddress: string,
	serverPort: number,
	options?: string | GetBaseAttributesOptions
): SpanBaseAttributes & { 'db.system.name': string } {
	let dbNamespace: string | undefined
	let peerAddress = serverAddress
	let peerPort = serverPort
	let nodeId: number | undefined
	let nodeDc: string | undefined
	if (options !== undefined) {
		if (typeof options === 'string') {
			dbNamespace = options
		} else {
			dbNamespace = options.dbNamespace
			if (options.peerAddress !== undefined)
				peerAddress = options.peerAddress
			if (options.peerPort !== undefined) peerPort = options.peerPort
			nodeId = options.nodeId
			nodeDc = options.nodeDc
		}
	}
	const attrs: SpanBaseAttributes & { 'db.system.name': string } = {
		'db.system.name': DB_SYSTEM,
		'server.address': serverAddress,
		'server.port': serverPort,
		'network.peer.address': peerAddress,
		'network.peer.port': peerPort,
	}
	if (dbNamespace) {
		attrs['db.namespace'] = dbNamespace
	}
	if (nodeId !== undefined) {
		attrs['ydb.node.id'] = nodeId
	}
	if (nodeDc !== undefined) {
		attrs['ydb.node.dc'] = nodeDc
	}
	return attrs
}

/**
 * Extracts db.response.status_code and error.type from an error for span attributes.
 * Normalizes all errors (including gRPC/transport like PROTOCOL_ERROR) to stable low-cardinality values.
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/#errorstype
 */
export function recordErrorAttributes(error: unknown): {
	'db.response.status_code': string
	'error.type': string
} {
	if (error instanceof YDBError) {
		const statusCode = YDBError.codes[error.code as StatusIds_StatusCode]
		return {
			'db.response.status_code': statusCode ?? 'UNKNOWN',
			'error.type': statusCode ?? 'UNKNOWN',
		}
	}

	// gRPC/transport errors (ClientError from nice-grpc): map code to stable error.type
	if (error instanceof ClientError) {
		const codeName =
			(Status as Record<number, string>)[error.code] ?? 'UNKNOWN'
		return {
			'db.response.status_code': codeName,
			'error.type': codeName,
		}
	}

	if (error instanceof Error && 'name' in error) {
		const name = error.name
		if (name === 'AbortError' || name.includes('Abort')) {
			return {
				'db.response.status_code': 'CANCELLED',
				'error.type': 'CANCELLED',
			}
		}
		if (name === 'TimeoutError' || name.includes('Timeout')) {
			return {
				'db.response.status_code': 'TIMEOUT',
				'error.type': 'TIMEOUT',
			}
		}
		// Other ClientError-like (e.g. from different package version) or transport errors
		if (name === 'ClientError') {
			return {
				'db.response.status_code': 'TRANSPORT_ERROR',
				'error.type': 'TRANSPORT_ERROR',
			}
		}
		// Message-based fallback for protocol/transport errors (e.g. PROTOCOL_ERROR)
		const msg = String((error as Error).message ?? '')
		if (
			/PROTOCOL_ERROR|TRANSPORT|UNAVAILABLE|DEADLINE|CANCELLED/i.test(msg)
		) {
			const type = /PROTOCOL/i.test(msg)
				? 'TRANSPORT_ERROR'
				: /UNAVAILABLE/i.test(msg)
					? 'UNAVAILABLE'
					: /DEADLINE|TIMEOUT/i.test(msg)
						? 'TIMEOUT'
						: /CANCELLED/i.test(msg)
							? 'CANCELLED'
							: 'TRANSPORT_ERROR'
			return {
				'db.response.status_code': type,
				'error.type': type,
			}
		}
	}

	return {
		'db.response.status_code': 'UNKNOWN',
		'error.type': 'UNKNOWN',
	}
}

export function formatTraceparent(
	traceId: string,
	spanId: string,
	traceFlags: number
): string {
	let flags = traceFlags.toString(16)
	if (flags.length < 2) flags = '0' + flags
	return `00-${traceId}-${spanId}-${flags}`
}

export const SpanFinalizer = {
	finishSuccess(span: Span): void {
		span.end()
	},
	finishByError(span: Span, error: unknown): void {
		const errAttrs = recordErrorAttributes(error)
		span.setAttributes(errAttrs)
		span.recordException(
			error instanceof Error ? error : new Error(String(error))
		)
		span.setStatus({ code: 2, message: String(error) })
		span.end()
	},

	whenComplete(span: Span): (error: Error | null) => void {
		return (error: Error | null) => {
			if (error) {
				SpanFinalizer.finishByError(span, error)
			} else {
				span.end()
			}
		}
	},
} as const
