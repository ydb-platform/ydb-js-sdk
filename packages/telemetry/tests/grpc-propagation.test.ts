import type { Metadata } from '@grpc/grpc-js'
import { create } from '@bufbuild/protobuf'
import {
	DiscoveryServiceDefinition,
	ListEndpointsResponseSchema,
	WhoAmIResponseSchema,
} from '@ydbjs/api/discovery'
import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { Driver, addMetadataHook } from '@ydbjs/core'
import { createTestServer } from '../../../tests/grpc-server.js'
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

// A loopback server records the actual headers sent by Driver without requiring tracing support in YDB.
async function driveThroughRealDriver(signal: AbortSignal): Promise<Metadata> {
	using _ = addMetadataHook(propagator)

	let server = createTestServer()
	let received: Metadata | undefined
	let discoveryService = {
		listEndpoints: DiscoveryServiceDefinition.listEndpoints,
		whoAmI: DiscoveryServiceDefinition.whoAmI,
	}

	server.add(discoveryService, {
		async listEndpoints(_request, callContext) {
			received = callContext.metadata
			return create(ListEndpointsResponseSchema, {})
		},
		async whoAmI() {
			return create(WhoAmIResponseSchema, {})
		},
	})

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	try {
		let client = driver.createClient(discoveryService)
		await client.listEndpoints({ database: driver.database }, { signal })

		if (!received) {
			throw new Error('listEndpoints was not invoked')
		}

		return received
	} finally {
		driver.close()
		await server.shutdown()
	}
}

test('injects traceparent into metadata when a span is active', async (tc) => {
	let tracer = trace.getTracer('test')
	let span = tracer.startSpan('outer')
	let traceparent: string | undefined
	await context.with(trace.setSpan(context.active(), span), async () => {
		let received = await driveThroughRealDriver(tc.signal)
		traceparent = String(received.get('traceparent')[0])
	})
	span.end()

	expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
	expect(traceparent).toContain(span.spanContext().traceId)
})

test('skips traceparent when no span is active', async (tc) => {
	let received = await driveThroughRealDriver(tc.signal)
	expect(received.get('traceparent')[0]).toBeUndefined()
})

test('preserves existing metadata entries alongside traceparent', async (tc) => {
	let tracer = trace.getTracer('test')
	let span = tracer.startSpan('outer')
	let received: Metadata | undefined
	await context.with(trace.setSpan(context.active(), span), async () => {
		received = await driveThroughRealDriver(tc.signal)
	})
	span.end()

	expect(received!.get('x-ydb-database')[0]).toBe('/local')
	expect(received!.get('traceparent')[0]).toBeDefined()
})

test('metadata hook leaves caller metadata unchanged', async (tc) => {
	await using fixture = {
		server: createTestServer(),
		[Symbol.asyncDispose]() {
			return this.server.shutdown()
		},
	}
	let receivedTrace: string | Uint8Array | undefined
	fixture.server.add(
		{ whoAmI: DiscoveryServiceDefinition.whoAmI },
		{
			async whoAmI(_request, callContext) {
				receivedTrace = callContext.metadata.get('traceparent')[0]
				return create(WhoAmIResponseSchema, {})
			},
		}
	)
	let port = await fixture.server.listen('127.0.0.1:0')
	using _ = addMetadataHook(propagator)
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let client = driver.createClient(DiscoveryServiceDefinition)
	let metadata = { 'x-existing': 'caller-value' }
	let span = trace.getTracer('test').startSpan('outer')

	try {
		await context.with(trace.setSpan(context.active(), span), () =>
			client.whoAmI({}, { metadata, signal: tc.signal })
		)
	} finally {
		span.end()
		client.close()
	}

	expect(receivedTrace).toContain(span.spanContext().traceId)
	expect(metadata).toEqual({ 'x-existing': 'caller-value' })
})
