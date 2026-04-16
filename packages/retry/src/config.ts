import type { Abortable } from 'node:events'

import type { RetryBudget } from './budget.js'
import type { RetryContext } from './context.js'
import type { RetryStrategy } from './strategy.js'

/**
 * Minimal span interface for retry instrumentation.
 * Structurally compatible with @ydbjs/telemetry Span.
 */
export interface RetrySpan {
	setAttribute(key: string, value: string | number | boolean): void
	recordException(error: Error): void
	setStatus(status: { code: number; message?: string }): void
	end(): void
	runInContext<T>(fn: () => T): T
}

/**
 * Minimal tracer interface for retry instrumentation.
 * Structurally compatible with @ydbjs/telemetry Tracer.
 */
export interface RetryTracer {
	startSpan(name: string, options?: { kind?: number }): RetrySpan
}

/**
 * Options for retry configuration
 */
export interface RetryConfig extends Abortable {
	/** Predicate to determine if an error is retryable */
	retry?: boolean | ((error: RetryContext['error'], idempotent: boolean) => boolean)
	/** Budget for retry attempts */
	budget?: number | RetryBudget
	/** Strategy to calculate delay */
	strategy?: number | RetryStrategy
	/** Idempotent operation */
	idempotent?: boolean

	/** Hook to be called before retrying */
	onRetry?: (ctx: RetryContext) => void

	/**
	 * Optional tracer for instrumentation.
	 * When provided, wraps the entire operation in a `ydb.RunWithRetry` span
	 * and each attempt in a `ydb.Try` span with a `ydb.retry.backoff_ms` attribute.
	 */
	tracer?: RetryTracer

	/**
	 * Override the name of the top-level span. Defaults to `ydb.RunWithRetry`.
	 */
	spanName?: string
}
