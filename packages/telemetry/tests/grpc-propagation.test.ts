import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { Driver, addClientMiddleware } from '@ydbjs/core'
import { createServer } from 'nice-grpc'
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

// Real path only: `addClientMiddleware(propagator)` + a real `Driver` +
// a real gRPC dispatch through a `nice-grpc` server on an ephemeral port
// (no Docker/YDB needed, `whoAmI`/`listEndpoints` are stubbed). This
// exercises nice-grpc's actual `composeClientMiddleware`/client-middleware
// invocation contract, unlike a hand-rolled `call.next` fake, which would
// keep passing even if nice-grpc changed how it drives client middleware.
async function driveThroughRealDriver(): Promise<{ get(key: string): string | undefined }> {
	using _ = addClientMiddleware(propagator)

	let server = createServer()
	let received: { get(key: string): string | undefined } | undefined
	let discoveryService = {
		listEndpoints: DiscoveryServiceDefinition.listEndpoints,
		whoAmI: DiscoveryServiceDefinition.whoAmI,
	}

	server.add(discoveryService, {
		async listEndpoints(_request, callContext) {
			received = callContext.metadata
			return {}
		},
		async whoAmI() {
			return {}
		},
	})

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	try {
		let client = driver.createClient(discoveryService)
		await client.listEndpoints({ database: driver.database })

		if (!received) {
			throw new Error('listEndpoints was not invoked')
		}

		return received
	} finally {
		driver.close()
		await server.shutdown()
	}
}

test('injects traceparent into metadata when a span is active', async () => {
	let tracer = trace.getTracer('test')
	let span = tracer.startSpan('outer')
	let traceparent: string | undefined
	await context.with(trace.setSpan(context.active(), span), async () => {
		let received = await driveThroughRealDriver()
		traceparent = received.get('traceparent')
	})
	span.end()

	expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
	expect(traceparent).toContain(span.spanContext().traceId)
})

test('skips traceparent when no span is active', async () => {
	let received = await driveThroughRealDriver()
	expect(received.get('traceparent')).toBeUndefined()
})

test('preserves existing metadata entries alongside traceparent', async () => {
	let tracer = trace.getTracer('test')
	let span = tracer.startSpan('outer')
	let received: { get(key: string): string | undefined } | undefined
	await context.with(trace.setSpan(context.active(), span), async () => {
		received = await driveThroughRealDriver()
	})
	span.end()

	// `x-ydb-database` is stamped onto outgoing metadata by core's own
	// `stamp` middleware (composed ahead of the propagator), so its
	// presence alongside traceparent confirms the propagator ran inside
	// the real chain rather than replacing prior entries.
	expect(received!.get('x-ydb-database')).toBe('/local')
	expect(received!.get('traceparent')).toBeDefined()
})
