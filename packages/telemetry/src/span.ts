import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
import { DB_SYSTEM, SpanFinalizer, SpanKind } from './tracing.js'
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
			SpanFinalizer.finishSuccess(span)
			return result
		})
		.catch((error) => {
			SpanFinalizer.finishByError(span, error)
			throw error
		})
}
