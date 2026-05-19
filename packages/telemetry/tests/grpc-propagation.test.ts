import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { ClientMiddleware, MethodDescriptor } from 'nice-grpc'
import { afterEach, beforeAll, expect, test } from 'vitest'

import { propagator } from '../src/propagation.ts'

let exporter = new InMemorySpanExporter()

beforeAll(() => {
	let provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	})
	trace.setGlobalTracerProvider(provider)
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
})

afterEach(() => exporter.reset())

// Drive a middleware like nice-grpc does at runtime: pump the generator,
// ignore yields, capture the options handed to call.next.
async function drive(
	mw: ClientMiddleware,
	options: Record<string, unknown>
): Promise<Record<string, unknown>> {
	let seen: Record<string, unknown> | undefined
	let call = {
		method: { path: '/test/method' } as unknown as MethodDescriptor,
		request: undefined,
		async *next(_req: unknown, opts: Record<string, unknown>) {
			seen = opts
			yield undefined
		},
	}

	let gen = (mw as any)(call, options) as AsyncGenerator
	for await (let chunk of gen) void chunk

	if (!seen) {
		throw new Error('call.next was not invoked')
	}

	return seen
}

test('injects traceparent into metadata when a span is active', async () => {
	let tracer = trace.getTracer('test')
	let span = tracer.startSpan('outer')
	let traceparent: string | undefined
	await context.with(trace.setSpan(context.active(), span), async () => {
		let opts = await drive(propagator, {})
		let m = opts.metadata as { get(k: string): string | undefined }
		traceparent = m.get('traceparent')
	})
	span.end()

	expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
	expect(traceparent).toContain(span.spanContext().traceId)
})

test('skips traceparent when no span is active', async () => {
	let opts = await drive(propagator, {})
	let m = opts.metadata as { get(k: string): string | undefined }
	expect(m.get('traceparent')).toBeUndefined()
})

test('preserves existing metadata entries alongside traceparent', async () => {
	let tracer = trace.getTracer('test')
	let span = tracer.startSpan('outer')
	let pre = new Map<string, string>([['x-ydb-database', '/local']])
	let m: { get(k: string): string | undefined } | undefined
	await context.with(trace.setSpan(context.active(), span), async () => {
		let opts = await drive(propagator, { metadata: pre })
		m = opts.metadata as { get(k: string): string | undefined }
	})
	span.end()

	expect(m!.get('x-ydb-database')).toBe('/local')
	expect(m!.get('traceparent')).toBeDefined()
})
