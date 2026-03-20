export { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
export { createSpan } from './span.js'
export { recordErrorAttributes } from './error.js'
export { DB_SYSTEM, SPAN_NAMES } from './constants.js'
export {
	formatTraceparent,
	getBaseAttributes,
	SpanFinalizer,
	type GetBaseAttributesOptions,
	type SpanBaseAttributes,
} from '@ydbjs/telemetry'
export type { Tracer, Span, SpanContext } from '@ydbjs/telemetry'
