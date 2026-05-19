import { YdbInstrumentation, type YdbInstrumentationConfig } from './instrumentation.js'

export { recordErrorAttributes } from './semconv/index.js'
export { getActiveSubscriberSpan } from './context.js'
export { YdbInstrumentation, type YdbInstrumentationConfig } from './instrumentation.js'

/**
 * Sugar over `new YdbInstrumentation(opts).enable()` for one-shot
 * registration. Use `registerInstrumentations()` from
 * @opentelemetry/instrumentation if you want to wire several instrumentations
 * together.
 */
export function register(opts?: YdbInstrumentationConfig): YdbInstrumentation {
	let instrumentation = new YdbInstrumentation(opts)
	instrumentation.enable()
	return instrumentation
}
