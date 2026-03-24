import { SpanKind, trace } from '@opentelemetry/api'
import type { Span as OtelSpan } from '@opentelemetry/api'
import { DB_SYSTEM, recordErrorAttributes } from './tracing.js'
import type { SpanBaseAttributes } from './tracing.js'
import pkg from '../package.json' with { type: 'json' }

/**
 * Wraps an operation in an OpenTelemetry span. For Driver-based tracing use
 * createOpenTelemetryTracer() and pass it as the tracer option.
 */
export function createSpan<T>(
	operationName: string,
	baseAttributes: SpanBaseAttributes & { 'db.system.name'?: string },
	fn: (span: OtelSpan) => Promise<T>
): Promise<T> {
	const tracer = trace.getTracer('ydb-sdk', pkg.version)
	const attrs = {
		'db.system.name': DB_SYSTEM,
		...baseAttributes,
	}
	const span = tracer.startSpan(operationName, {
		kind: SpanKind.CLIENT,
		attributes: attrs,
	})

	return fn(span)
		.then((result) => {
			span.end()
			return result
		})
		.catch((error) => {
			const errAttrs = recordErrorAttributes(error)
			span.setAttributes(errAttrs)
			span.recordException(error)
			span.setStatus({ code: 2, message: String(error) })
			span.end()
			throw error
		})
}
