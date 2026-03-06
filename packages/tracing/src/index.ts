export { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
export { createSpan } from './span.js'
export { recordErrorAttributes } from './error.js'
export { DB_SYSTEM, SPAN_NAMES } from './constants.js'
export { formatTraceparent } from './traceparent.js'
export {
	getBaseAttributes,
	SpanFinalizer,
	type GetBaseAttributesOptions,
	type SpanBaseAttributes,
} from '@ydbjs/core'
export type { Tracer, Span, SpanContext } from '@ydbjs/core'
