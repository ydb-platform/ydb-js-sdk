import { SpanKind, trace } from '@opentelemetry/api'
import {
	DB_SYSTEM,
	type Span,
	type SpanBaseAttributes,
	recordErrorAttributes,
} from '@ydbjs/telemetry'
import { wrapOtelSpan } from './open-telemetry-tracer.js'
import pkg from '../package.json' with { type: 'json' }

/**
 * Wraps an operation in an OpenTelemetry span. For Driver-based tracing use
 * createOpenTelemetryTracer() and pass it as the tracer option.
 */
export function createSpan<T>(
	operationName: string,
	baseAttributes: SpanBaseAttributes & { 'db.system.name'?: string },
	fn: (span: Span) => Promise<T>
): Promise<T> {
	const tracer = trace.getTracer('Ydb.Sdk', pkg.version)
	const attrs = {
		'db.system.name': DB_SYSTEM,
		...baseAttributes,
	}
	const otelSpan = tracer.startSpan(operationName, {
		kind: SpanKind.CLIENT,
		attributes: attrs,
	})
	const span = wrapOtelSpan(otelSpan)

	return fn(span)
		.then((result) => {
			span.end()
			return result
		})
		.catch((error: unknown) => {
			const errAttrs = recordErrorAttributes(error)
			span.setAttributes(errAttrs)
			span.recordException(error instanceof Error ? error : new Error(String(error)))
			span.setStatus({ code: 2, message: String(error) })
			span.end()
			throw error
		})
}
