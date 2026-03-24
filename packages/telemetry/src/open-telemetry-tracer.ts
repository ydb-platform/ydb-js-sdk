import { SpanKind, context, trace } from '@opentelemetry/api'
import type { Span as OtelSpan } from '@opentelemetry/api'
import {
	type Span,
	type SpanContext,
	type StartSpanOptions,
	type Tracer,
	recordErrorAttributes,
} from './tracing.js'
import { formatTraceparent } from './traceparent.js'
import pkg from '../package.json' with { type: 'json' }

function wrapOtelSpan(otelSpan: OtelSpan): Span {
	return {
		getId(): string {
			const ctx = otelSpan.spanContext()
			return formatTraceparent(ctx.traceId, ctx.spanId, ctx.traceFlags)
		},
		spanContext(): SpanContext {
			const ctx = otelSpan.spanContext()
			return {
				traceId: ctx.traceId,
				spanId: ctx.spanId,
				traceFlags: ctx.traceFlags,
			}
		},
		setAttribute(key: string, value: string | number | boolean): void {
			otelSpan.setAttribute(key, value)
		},
		setAttributes(attrs: Record<string, string | number | boolean>): void {
			otelSpan.setAttributes(attrs)
		},
		end(): void {
			otelSpan.end()
		},
		recordException(error: Error): void {
			const attrs = recordErrorAttributes(error)
			otelSpan.setAttributes(attrs)
			otelSpan.recordException(error)
			otelSpan.setStatus({ code: 2, message: String(error) })
		},
		setStatus(status: { code: number; message?: string }): void {
			otelSpan.setStatus(status)
		},
		runInContext<T>(fn: () => T): T {
			return context.with(trace.setSpan(context.active(), otelSpan), fn)
		},
	}
}

export function createOpenTelemetryTracer(): Tracer {
	const tracer = trace.getTracer('ydb-sdk', pkg.version)
	return {
		startSpan(name: string, options?: StartSpanOptions): Span {
			const kind = options?.kind === 1 ? SpanKind.CLIENT : SpanKind.INTERNAL
			const attrs = options?.attributes
			const otelSpan = tracer.startSpan(name, {
				kind,
				...(attrs !== undefined && { attributes: attrs }),
			})
			return wrapOtelSpan(otelSpan)
		},
	}
}
