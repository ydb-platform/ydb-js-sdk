/**
 * Verifies that parent → child span relationships are correctly wired via
 * AsyncLocalStorage when tracing channels are nested.
 *
 * The expected hierarchy mirrors what the SDK produces at runtime:
 *
 *   ydb.Transaction
 *     └─ ydb.ExecuteQuery   (query inside a tx body)
 *
 *   ydb.RunWithRetry
 *     └─ ydb.Try
 *          └─ ydb.CreateSession
 */
import { tracingChannel } from 'node:diagnostics_channel'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { subscribe } from '../src/subscribe.ts'
import { getActiveSubscriberSpan } from '../src/context-manager.ts'

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

let unsubscribe: () => void

beforeAll(() => {
	unsubscribe = subscribe()
})

afterAll(() => {
	unsubscribe()
	exporter.reset()
})

test('ydb.ExecuteQuery is a child of ydb.Transaction when nested via ALS', async () => {
	let txCh = tracingChannel<{ isolation: string; idempotent: boolean }>(
		'tracing:ydb:query.transaction'
	)
	let execCh = tracingChannel<{
		text: string
		sessionId: string
		nodeId: bigint
		idempotent: boolean
		isolation: string
		stage: string
	}>('tracing:ydb:query.execute')

	let txCtx = { isolation: 'serializableReadWrite', idempotent: false }
	let execCtx = {
		text: 'SELECT 1',
		sessionId: 'sess-1',
		nodeId: 1n,
		idempotent: false,
		isolation: 'serializableReadWrite',
		stage: 'tx',
	}

	let txSpanInsideHandler: unknown
	let execSpanInsideHandler: unknown

	await txCh.tracePromise(async () => {
		txSpanInsideHandler = getActiveSubscriberSpan()
		await execCh.tracePromise(async () => {
			execSpanInsideHandler = getActiveSubscriberSpan()
		}, execCtx)
	}, txCtx)

	expect(txSpanInsideHandler).not.toBeUndefined()
	expect(execSpanInsideHandler).not.toBeUndefined()
	expect(txSpanInsideHandler).not.toBe(execSpanInsideHandler)

	let spans = exporter.getFinishedSpans()
	let txSpan = spans.find((s) => s.name === 'ydb.Transaction')
	let execSpan = spans.find((s) => s.name === 'ydb.ExecuteQuery')

	expect(txSpan).toBeDefined()
	expect(execSpan).toBeDefined()

	// ExecuteQuery should be a child of Transaction
	expect(execSpan!.parentSpanContext?.spanId).toBe(txSpan!.spanContext().spanId)
})

test('ydb.CreateSession is nested under ydb.Try under ydb.RunWithRetry', async () => {
	exporter.reset()

	let retryRunCh = tracingChannel<{ database: string }>('tracing:ydb:retry.run')
	let retryAttemptCh = tracingChannel<{ attempt: number; database: string }>(
		'tracing:ydb:retry.attempt'
	)
	let sessionCreateCh = tracingChannel<{
		liveSessions: number
		maxSize: number
		creating: number
	}>('tracing:ydb:session.create')

	let runCtx = { database: '/local' }
	let attemptCtx = { attempt: 1, database: '/local' }
	let createCtx = { liveSessions: 0, maxSize: 50, creating: 0 }

	await retryRunCh.tracePromise(async () => {
		await retryAttemptCh.tracePromise(async () => {
			await sessionCreateCh.tracePromise(async () => {}, createCtx)
		}, attemptCtx)
	}, runCtx)

	let spans = exporter.getFinishedSpans()
	let runSpan = spans.find((s) => s.name === 'ydb.RunWithRetry')
	let trySpan = spans.find((s) => s.name === 'ydb.Try')
	let createSpan = spans.find((s) => s.name === 'ydb.CreateSession')

	expect(runSpan).toBeDefined()
	expect(trySpan).toBeDefined()
	expect(createSpan).toBeDefined()

	expect(trySpan!.parentSpanContext?.spanId).toBe(runSpan!.spanContext().spanId)
	expect(createSpan!.parentSpanContext?.spanId).toBe(trySpan!.spanContext().spanId)
})
