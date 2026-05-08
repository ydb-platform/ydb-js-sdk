import { type SpanContext, type TextMapSetter, context, trace } from '@opentelemetry/api'
import { TRACE_PARENT_HEADER, W3CTraceContextPropagator } from '@opentelemetry/core'

let propagator = new W3CTraceContextPropagator()

let traceparentSetter: TextMapSetter<Record<string, string>> = {
	set(carrier, key, value) {
		carrier[key] = value
	},
}

export function formatTraceparent(traceId: string, spanId: string, traceFlags: number): string {
	let spanContext: SpanContext = { traceId, spanId, traceFlags }
	let ctx = trace.setSpanContext(context.active(), spanContext)
	let carrier: Record<string, string> = {}
	propagator.inject(ctx, carrier, traceparentSetter)
	return carrier[TRACE_PARENT_HEADER] ?? ''
}
