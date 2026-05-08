import { recordErrorAttributes } from './attributes.js'

export let SpanKind = {
	INTERNAL: 0,
	CLIENT: 1,
} as const

export type SpanContext = {
	traceId: string
	spanId: string
	traceFlags: number
}

export type Span = {
	/**
	 * Returns W3C traceparent string (e.g. "00-<traceId>-<spanId>-<flags>") for propagation.
	 * Empty string for no-op spans.
	 */
	getId(): string
	spanContext(): SpanContext
	setAttribute(key: string, value: string | number | boolean): void
	setAttributes(attrs: Record<string, string | number | boolean>): void
	end(): void
	recordException(error: Error): void
	setStatus(status: { code: number; message?: string }): void
	runInContext<T>(fn: () => T): T
}

export type StartSpanOptions = {
	kind?: (typeof SpanKind)[keyof typeof SpanKind]
	attributes?: Record<string, string | number | boolean>
}

export type Tracer = {
	startSpan(name: string, options?: StartSpanOptions): Span
}

class NoopSpan implements Span {
	getId(): string {
		return ''
	}
	spanContext(): SpanContext {
		return { traceId: '', spanId: '', traceFlags: 0 }
	}
	setAttribute(_key: string, _value: string | number | boolean): void {}
	setAttributes(_attrs: Record<string, string | number | boolean>): void {}
	end(): void {}
	recordException(_error: Error): void {}
	setStatus(_status: { code: number; message?: string }): void {}
	runInContext<T>(fn: () => T): T {
		return fn()
	}
}

export let NoopTracer: Tracer = {
	startSpan(_name: string, _options?: StartSpanOptions): Span {
		return new NoopSpan()
	},
}

export let SpanFinalizer = {
	finishSuccess(span: Span): void {
		span.end()
	},
	finishByError(span: Span, error: unknown): void {
		let errAttrs = recordErrorAttributes(error)
		span.setAttributes(errAttrs)
		span.recordException(error instanceof Error ? error : new Error(String(error)))
		span.setStatus({ code: 2, message: String(error) })
		span.end()
	},

	whenComplete(span: Span): (error: Error | null) => void {
		return (error: Error | null) => {
			if (error) {
				SpanFinalizer.finishByError(span, error)
			} else {
				span.end()
			}
		}
	},
} as const
