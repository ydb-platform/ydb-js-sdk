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

	// The active subscriber span inside tx handler is the Transaction span.
	// ExecuteQuery is a leaf — it does NOT push to spanStorage, so the active span stays as Transaction.
	let txSpanInsideHandler: unknown

	await txCh.tracePromise(async () => {
		txSpanInsideHandler = getActiveSubscriberSpan()
		await execCh.tracePromise(async () => {}, execCtx)
	}, txCtx)

	expect(txSpanInsideHandler).not.toBeUndefined()

	let spans = exporter.getFinishedSpans()
	let txSpan = spans.find((s) => s.name === 'ydb.Transaction')
	let execSpan = spans.find((s) => s.name === 'ydb.ExecuteQuery')

	expect(txSpan).toBeDefined()
	expect(execSpan).toBeDefined()

	// ExecuteQuery is a leaf span parented to Transaction via startChild reading spanStorage.
	expect(execSpan!.parentSpanContext?.spanId).toBe(txSpan!.spanContext().spanId)
})

test('ydb.ExecuteQuery (standalone) is NOT a child of ydb.CreateSession', async () => {
	exporter.reset()

	let sessionCreateCh = tracingChannel<{
		liveSessions: number
		maxSize: number
		creating: number
	}>('tracing:ydb:session.create')
	let execCh = tracingChannel<{
		text: string
		sessionId: string
		nodeId: bigint
		idempotent: boolean
		isolation: string
		stage: string
	}>('tracing:ydb:query.execute')

	// Simulate the SDK pattern: execute fires inside session.create's channel scope.
	await sessionCreateCh.tracePromise(
		async () => {
			await execCh.tracePromise(async () => {}, {
				text: 'SELECT 1',
				sessionId: 'sess-sibling',
				nodeId: 1n,
				idempotent: true,
				isolation: 'serializableReadWrite',
				stage: 'standalone',
			})
		},
		{ liveSessions: 0, maxSize: 50, creating: 1 }
	)

	let spans = exporter.getFinishedSpans()
	let createSpan = spans.find((s) => s.name === 'ydb.CreateSession')
	let execSpan = spans.find((s) => s.name === 'ydb.ExecuteQuery')

	expect(createSpan).toBeDefined()
	expect(execSpan).toBeDefined()

	// ExecuteQuery must NOT be parented under CreateSession — they are siblings.
	expect(execSpan!.parentSpanContext?.spanId).not.toBe(createSpan!.spanContext().spanId)
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

test('ydb.CreateSession is a child of ydb.AcquireSession when pool grows', async () => {
	exporter.reset()

	let sessionAcquireCh = tracingChannel<{ kind: 'query' | 'transaction' }>(
		'tracing:ydb:session.acquire'
	)
	let sessionCreateCh = tracingChannel<{
		liveSessions: number
		maxSize: number
		creating: number
	}>('tracing:ydb:session.create')

	await sessionAcquireCh.tracePromise(
		async () => {
			await sessionCreateCh.tracePromise(async () => {}, {
				liveSessions: 0,
				maxSize: 50,
				creating: 1,
			})
		},
		{ kind: 'query' }
	)

	let spans = exporter.getFinishedSpans()
	let acquireSpan = spans.find((s) => s.name === 'ydb.AcquireSession')
	let createSpan = spans.find((s) => s.name === 'ydb.CreateSession')

	expect(acquireSpan).toBeDefined()
	expect(createSpan).toBeDefined()
	expect(createSpan!.parentSpanContext?.spanId).toBe(acquireSpan!.spanContext().spanId)
})

test('ydb.ExecuteQuery is sibling of ydb.AcquireSession under ydb.Try', async () => {
	exporter.reset()

	let retryAttemptCh = tracingChannel<{ attempt: number; database: string }>(
		'tracing:ydb:retry.attempt'
	)
	let sessionAcquireCh = tracingChannel<{ kind: 'query' | 'transaction' }>(
		'tracing:ydb:session.acquire'
	)
	let execCh = tracingChannel<{
		text: string
		sessionId: string
		nodeId: bigint
		idempotent: boolean
		isolation: string
		stage: string
	}>('tracing:ydb:query.execute')

	await retryAttemptCh.tracePromise(
		async () => {
			await sessionAcquireCh.tracePromise(async () => {}, { kind: 'query' })
			await execCh.tracePromise(async () => {}, {
				text: 'SELECT 1',
				sessionId: 'sess-try',
				nodeId: 1n,
				idempotent: true,
				isolation: 'serializableReadWrite',
				stage: 'standalone',
			})
		},
		{ attempt: 1, database: '/local' }
	)

	let spans = exporter.getFinishedSpans()
	let trySpan = spans.find((s) => s.name === 'ydb.Try')
	let acquireSpan = spans.find((s) => s.name === 'ydb.AcquireSession')
	let execSpan = spans.find((s) => s.name === 'ydb.ExecuteQuery')

	expect(trySpan).toBeDefined()
	expect(acquireSpan).toBeDefined()
	expect(execSpan).toBeDefined()

	// Both should be children of Try, but not parent/child with each other.
	expect(acquireSpan!.parentSpanContext?.spanId).toBe(trySpan!.spanContext().spanId)
	expect(execSpan!.parentSpanContext?.spanId).toBe(trySpan!.spanContext().spanId)
	expect(execSpan!.parentSpanContext?.spanId).not.toBe(acquireSpan!.spanContext().spanId)
})
