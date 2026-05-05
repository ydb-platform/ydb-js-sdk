import { expect, test } from 'vitest'

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import {
	DB_SYSTEM,
	SPAN_NAMES,
	getBaseAttributes,
	recordErrorAttributes,
} from '../src/attributes.ts'
import { createSpan } from '../src/span.ts'
import { createOpenTelemetryTracer } from '../src/open-telemetry-tracer.ts'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'

// ── OTel provider ────────────────────────────────────────────────────────────

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

let TRACEPARENT_REGEX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

// ── Constants ────────────────────────────────────────────────────────────────

test('DB_SYSTEM equals ydb', () => {
	expect(DB_SYSTEM).toBe('ydb')
})

test('SPAN_NAMES contains RunWithRetry', () => {
	expect(SPAN_NAMES.RunWithRetry).toBe('ydb.RunWithRetry')
})

test('SPAN_NAMES contains Try', () => {
	expect(SPAN_NAMES.Try).toBe('ydb.Try')
})

test('SPAN_NAMES contains CreateSession', () => {
	expect(SPAN_NAMES.CreateSession).toBe('ydb.CreateSession')
})

test('SPAN_NAMES contains ExecuteQuery', () => {
	expect(SPAN_NAMES.ExecuteQuery).toBe('ydb.ExecuteQuery')
})

test('SPAN_NAMES contains Commit', () => {
	expect(SPAN_NAMES.Commit).toBe('ydb.Commit')
})

test('SPAN_NAMES contains Rollback', () => {
	expect(SPAN_NAMES.Rollback).toBe('ydb.Rollback')
})

test('SPAN_NAMES contains Transaction', () => {
	expect(SPAN_NAMES.Transaction).toBe('ydb.Transaction')
})

test('SPAN_NAMES contains Discovery', () => {
	expect(SPAN_NAMES.Discovery).toBe('ydb.Discovery')
})

// ── getBaseAttributes ────────────────────────────────────────────────────────

test('getBaseAttributes returns db.system.name, server and network.peer fields', () => {
	let attrs = getBaseAttributes('localhost', 2135)
	expect(attrs['db.system.name']).toBe(DB_SYSTEM)
	expect(attrs['server.address']).toBe('localhost')
	expect(attrs['server.port']).toBe(2135)
	expect(attrs['network.peer.address']).toBe('localhost')
	expect(attrs['network.peer.port']).toBe(2135)
	expect(attrs['db.namespace']).toBeUndefined()
})

test('getBaseAttributes includes db.namespace when provided as string', () => {
	let attrs = getBaseAttributes('ydb.example.com', 2135, '/local')
	expect(attrs['db.namespace']).toBe('/local')
})

test('getBaseAttributes accepts options object with peer and node', () => {
	let attrs = getBaseAttributes('server.ydb', 2135, {
		dbNamespace: '/prod',
		peerAddress: '10.0.0.1',
		peerPort: 2136,
		nodeId: 1,
		nodeDc: 'dc1',
	})
	expect(attrs['server.address']).toBe('server.ydb')
	expect(attrs['network.peer.address']).toBe('10.0.0.1')
	expect(attrs['network.peer.port']).toBe(2136)
	expect(attrs['db.namespace']).toBe('/prod')
	expect(attrs['ydb.node.id']).toBe(1)
	expect(attrs['ydb.node.dc']).toBe('dc1')
})

// ── createSpan ───────────────────────────────────────────────────────────────

test('createSpan returns result of fn when fn resolves', async () => {
	let base = getBaseAttributes('localhost', 2136)
	let result = await createSpan('test.op', base, async () => 42)
	expect(result).toBe(42)
})

test('createSpan rethrows when fn rejects', async () => {
	let base = getBaseAttributes('localhost', 2136)
	let err = new Error('expected failure')
	await expect(
		createSpan('test.op', base, async () => {
			throw err
		})
	).rejects.toThrow('expected failure')
})

test('createSpan passes span to fn', async () => {
	let base = getBaseAttributes('localhost', 2136)
	let receivedSpan = null as unknown
	await createSpan('test.op', base, async (span) => {
		receivedSpan = span
		return undefined
	})
	expect(receivedSpan).not.toBeNull()
	expect(typeof (receivedSpan as { end: unknown }).end).toBe('function')
})

// ── createOpenTelemetryTracer ────────────────────────────────────────────────

test('createOpenTelemetryTracer span getId() returns W3C traceparent format', () => {
	let tracer = createOpenTelemetryTracer()
	let span = tracer.startSpan('test.operation', { kind: 1 })
	let id = span.getId()
	expect(id).toMatch(TRACEPARENT_REGEX)
	expect(id.startsWith('00-')).toBe(true)
	span.end()
})

test('createOpenTelemetryTracer span getId() matches spanContext for propagation', () => {
	let tracer = createOpenTelemetryTracer()
	let span = tracer.startSpan('test.operation', { kind: 1 })
	let ctx = span.spanContext()
	let id = span.getId()
	expect(id).toContain(ctx.traceId)
	expect(id).toContain(ctx.spanId)
	span.end()
})

// ── recordErrorAttributes ────────────────────────────────────────────────────

test('recordErrorAttributes returns status and type for YDBError', () => {
	let error = new YDBError(StatusIds_StatusCode.ABORTED, [])
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('ABORTED')
	expect(attrs['error.type']).toBe('ABORTED')
})

test('recordErrorAttributes maps YDBError TIMEOUT code', () => {
	let error = new YDBError(StatusIds_StatusCode.TIMEOUT, [])
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TIMEOUT')
	expect(attrs['error.type']).toBe('TIMEOUT')
})

test('recordErrorAttributes maps YDBError CANCELLED code', () => {
	let error = new YDBError(StatusIds_StatusCode.CANCELLED, [])
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('CANCELLED')
	expect(attrs['error.type']).toBe('CANCELLED')
})

test('recordErrorAttributes returns CANCELLED for AbortError', () => {
	let error = new Error('aborted')
	error.name = 'AbortError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('CANCELLED')
	expect(attrs['error.type']).toBe('CANCELLED')
})

test('recordErrorAttributes returns CANCELLED for error with Abort in name', () => {
	let error = new Error('aborted')
	error.name = 'CustomAbortSomething'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('CANCELLED')
	expect(attrs['error.type']).toBe('CANCELLED')
})

test('recordErrorAttributes returns TIMEOUT for TimeoutError', () => {
	let error = new Error('timed out')
	error.name = 'TimeoutError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TIMEOUT')
	expect(attrs['error.type']).toBe('TIMEOUT')
})

test('recordErrorAttributes returns TIMEOUT for error with Timeout in name', () => {
	let error = new Error('timed out')
	error.name = 'RequestTimeoutError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TIMEOUT')
	expect(attrs['error.type']).toBe('TIMEOUT')
})

test('recordErrorAttributes returns TRANSPORT_ERROR for ClientError', () => {
	let error = new Error('connection failed')
	error.name = 'ClientError'
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('TRANSPORT_ERROR')
	expect(attrs['error.type']).toBe('TRANSPORT_ERROR')
})

test('recordErrorAttributes returns UNKNOWN for generic Error', () => {
	let error = new Error('something went wrong')
	let attrs = recordErrorAttributes(error)
	expect(attrs['db.response.status_code']).toBe('UNKNOWN')
	expect(attrs['error.type']).toBe('UNKNOWN')
})

test('recordErrorAttributes returns UNKNOWN for non-Error value', () => {
	let attrs = recordErrorAttributes('string error')
	expect(attrs['db.response.status_code']).toBe('UNKNOWN')
	expect(attrs['error.type']).toBe('UNKNOWN')
})

test('recordErrorAttributes returns UNKNOWN for null', () => {
	let attrs = recordErrorAttributes(null)
	expect(attrs['db.response.status_code']).toBe('UNKNOWN')
	expect(attrs['error.type']).toBe('UNKNOWN')
})
