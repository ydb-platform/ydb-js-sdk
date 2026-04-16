import { AsyncLocalStorage } from 'node:async_hooks'

export type TracingContextStore = {
	span?: unknown
	queryText?: string
	/**
	 * Optional tracer for retry instrumentation (RetryTracer-compatible).
	 * Stored as unknown to avoid a cross-package dependency on @ydbjs/retry.
	 */
	tracer?: unknown
}

export const tracingContext = new AsyncLocalStorage<TracingContextStore>()
