import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
import { DB_SYSTEM, type SpanBaseAttributes } from './attributes.js'
import { SpanFinalizer, SpanKind } from './tracing.js'
import type { Span, Tracer } from './tracing.js'

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
	let activeTracer = tracer ?? createOpenTelemetryTracer()
	let span = activeTracer.startSpan(operationName, {
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
