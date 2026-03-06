import { expect, test } from 'vitest'

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'

import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
provider.register()

const TRACEPARENT_REGEX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

test('createOpenTelemetryTracer span getId() returns W3C traceparent format', () => {
	const tracer = createOpenTelemetryTracer()
	const span = tracer.startSpan('test.operation', { kind: 1 })
	const id = span.getId()
	expect(id).toMatch(TRACEPARENT_REGEX)
	expect(id.startsWith('00-')).toBe(true)
	span.end()
})

test('createOpenTelemetryTracer span getId() matches spanContext for propagation', () => {
	const tracer = createOpenTelemetryTracer()
	const span = tracer.startSpan('test.operation', { kind: 1 })
	const ctx = span.spanContext()
	const id = span.getId()
	expect(id).toContain(ctx.traceId)
	expect(id).toContain(ctx.spanId)
	span.end()
})
