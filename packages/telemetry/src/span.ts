import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
import { DB_SYSTEM, SpanKind, recordErrorAttributes } from './tracing.js'
import type { Span, SpanBaseAttributes, Tracer } from './tracing.js'

/**
 * Wraps an operation in a span. Accepts an optional tracer — defaults to the
 * global OpenTelemetry tracer. For Driver-based tracing prefer withTracing().
 */
export function createSpan<T>(
	operationName: string,
	baseAttributes: SpanBaseAttributes & { 'db.system.name'?: string },
	fn: (span: Span) => Promise<T>,
	tracer?: Tracer
): Promise<T> {
	const activeTracer = tracer ?? createOpenTelemetryTracer()
	const span = activeTracer.startSpan(operationName, {
		kind: SpanKind.CLIENT,
		attributes: { 'db.system.name': DB_SYSTEM, ...baseAttributes },
	})

	return fn(span)
		.then((result) => {
			span.end()
			return result
		})
		.catch((error) => {
			const errAttrs = recordErrorAttributes(error)
			span.setAttributes(errAttrs)
			span.recordException(error instanceof Error ? error : new Error(String(error)))
			span.setStatus({ code: 2, message: String(error) })
			span.end()
			throw error
		})
}
