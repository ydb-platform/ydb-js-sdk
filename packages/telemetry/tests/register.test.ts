/**
 * Tests for register() idempotency:
 *   - Each call creates independent subscriptions.
 *   - The Disposer returned by each call removes only that call's subscriptions.
 *   - The first registration remains active after the second's Disposer fires.
 */
import { tracingChannel } from 'node:diagnostics_channel'
import { afterEach, expect, test } from 'vitest'

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { register } from '../src/index.ts'

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

afterEach(() => {
	exporter.reset()
})

// Helper — fires tracing:ydb:query.execute once and waits for async completion.
async function fireExecute(text = 'SELECT 1'): Promise<void> {
	let ch = tracingChannel<{
		text: string
		sessionId: string
		nodeId: bigint
		idempotent: boolean
		isolation: string
		stage: string
		_parentSpan: undefined
	}>('tracing:ydb:query.execute')

	await ch.tracePromise(async () => {}, {
		text,
		sessionId: 'test-session',
		nodeId: 1n,
		idempotent: false,
		isolation: 'implicit',
		stage: 'standalone',
		_parentSpan: undefined,
	})
}

test('register() produces spans for the registered channels', async () => {
	let stop = register({ metrics: false })

	await fireExecute()

	let spans = exporter.getFinishedSpans()
	expect(spans.some((s) => s.name === 'ydb.ExecuteQuery')).toBe(true)

	stop()
})

test('register() called twice creates two independent subscriptions', async () => {
	let stop1 = register({ metrics: false })
	let stop2 = register({ metrics: false })

	await fireExecute()

	// Two registrations → two ydb.ExecuteQuery spans for the same channel fire.
	let spans = exporter.getFinishedSpans()
	let execSpans = spans.filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(execSpans.length).toBe(2)

	stop1()
	stop2()
})

test('disposing second registration leaves first active', async () => {
	let stop1 = register({ metrics: false })
	let stop2 = register({ metrics: false })

	// Dispose only the second registration.
	stop2()
	exporter.reset()

	await fireExecute()

	// Only one subscription (stop1) remains → exactly one span.
	let spans = exporter.getFinishedSpans()
	let execSpans = spans.filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(execSpans.length).toBe(1)

	stop1()
})

test('disposing first registration leaves second active', async () => {
	let stop1 = register({ metrics: false })
	let stop2 = register({ metrics: false })

	// Dispose only the first registration.
	stop1()
	exporter.reset()

	await fireExecute()

	// Only one subscription (stop2) remains → exactly one span.
	let spans = exporter.getFinishedSpans()
	let execSpans = spans.filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(execSpans.length).toBe(1)

	stop2()
})

test('disposing both registrations leaves no active subscriptions', async () => {
	let stop1 = register({ metrics: false })
	let stop2 = register({ metrics: false })

	stop1()
	stop2()
	exporter.reset()

	await fireExecute()

	let spans = exporter.getFinishedSpans()
	let execSpans = spans.filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(execSpans.length).toBe(0)
})

test('register() called three times — middle disposer does not affect others', async () => {
	let stop1 = register({ metrics: false })
	let stop2 = register({ metrics: false })
	let stop3 = register({ metrics: false })

	stop2()
	exporter.reset()

	await fireExecute()

	// stop1 and stop3 still active → 2 spans.
	let spans = exporter.getFinishedSpans()
	let execSpans = spans.filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(execSpans.length).toBe(2)

	stop1()
	stop3()
})
