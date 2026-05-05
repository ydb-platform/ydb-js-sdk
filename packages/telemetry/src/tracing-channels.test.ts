import { tracingChannel } from 'node:diagnostics_channel'
import { afterAll, beforeEach, expect, test } from 'vitest'

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { SPAN_NAMES, createOpenTelemetryTracer, subscribe } from './index.ts'

type SessionCreateCtx = { liveSessions: number; maxSize: number; creating: number }

type ExecuteCtx = {
	text: string
	sessionId: string
	nodeId: bigint
	idempotent: boolean
	isolation: string
	stage: string
	error?: unknown
}

type TransactionCtx = { isolation: string; idempotent: boolean }

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

let sessionCreateCh = tracingChannel<SessionCreateCtx>('tracing:ydb:session.create')
let executeCh = tracingChannel<ExecuteCtx>('tracing:ydb:query.execute')
let transactionCh = tracingChannel<TransactionCtx>('tracing:ydb:query.transaction')

let unsub = subscribe({
	tracer: createOpenTelemetryTracer(),
	endpoint: 'grpc://127.0.0.1:2136/local',
	captureQueryText: true,
})

afterAll(() => {
	unsub()
})

beforeEach(() => {
	exporter.reset()
})

test('creates spans for CreateSession and ExecuteQuery', async () => {
	await sessionCreateCh.tracePromise(async () => {
		await executeCh.tracePromise(async () => {}, {
			text: 'SELECT 1 AS id',
			sessionId: 'sess-1',
			nodeId: 1n,
			idempotent: true,
			isolation: 'serializableReadWrite',
			stage: 'standalone',
		})
	}, { liveSessions: 1, maxSize: 10, creating: 0 })

	let spanNames = exporter.getFinishedSpans().map((s) => s.name)
	expect(spanNames).toContain(SPAN_NAMES.CreateSession)
	expect(spanNames).toContain(SPAN_NAMES.ExecuteQuery)
})

test('ExecuteQuery span has db.query.text attribute', async () => {
	await executeCh.tracePromise(async () => {}, {
		text: 'SELECT 42 AS id',
		sessionId: 'sess-2',
		nodeId: 2n,
		idempotent: false,
		isolation: 'serializableReadWrite',
		stage: 'standalone',
	})

	let executeSpan = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.ExecuteQuery)
	expect(executeSpan).toBeDefined()
	expect(executeSpan!.attributes['db.query.text']).toContain('SELECT 42 AS id')
	expect(executeSpan!.attributes['db.system.name']).toBe('ydb')
})

test('creates Transaction span around ExecuteQuery', async () => {
	await transactionCh.tracePromise(async () => {
		await executeCh.tracePromise(async () => {}, {
			text: 'SELECT 1 AS id',
			sessionId: 'sess-3',
			nodeId: 3n,
			idempotent: true,
			isolation: 'serializableReadWrite',
			stage: 'tx',
		})
	}, { isolation: 'serializableReadWrite', idempotent: true })

	let spanNames = exporter.getFinishedSpans().map((s) => s.name)
	expect(spanNames).toContain(SPAN_NAMES.Transaction)
	expect(spanNames).toContain(SPAN_NAMES.ExecuteQuery)
})

test('Transaction span has isolation attribute', async () => {
	await transactionCh.tracePromise(async () => {
		await executeCh.tracePromise(async () => {}, {
			text: 'SELECT 1 AS id',
			sessionId: 'sess-4',
			nodeId: 4n,
			idempotent: false,
			isolation: 'serializableReadWrite',
			stage: 'tx',
		})
	}, { isolation: 'serializableReadWrite', idempotent: false })

	let txSpan = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.Transaction)
	expect(txSpan).toBeDefined()
	expect(txSpan!.attributes['ydb.isolation']).toBe('serializableReadWrite')
})

test('ExecuteQuery rejection sets error status on span', async () => {
	let err = new Error('query failed')
	await expect(
		executeCh.tracePromise(async () => {
			throw err
		}, {
			text: 'SELECT * FROM bad',
			sessionId: 'sess-5',
			nodeId: 5n,
			idempotent: false,
			isolation: 'serializableReadWrite',
			stage: 'standalone',
		})
	).rejects.toThrow('query failed')

	let errorSpan = exporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.ExecuteQuery)
	expect(errorSpan).toBeDefined()
	expect(errorSpan!.status?.code).toBe(2)
	expect(errorSpan!.attributes['error.type']).toBeDefined()
})

test('subscribe returns working unsubscribe function', () => {
	let unsubLocal = subscribe(createOpenTelemetryTracer())
	expect(typeof unsubLocal).toBe('function')
	unsubLocal()
})
