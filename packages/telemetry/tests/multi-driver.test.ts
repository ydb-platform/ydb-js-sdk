import { tracingChannel } from 'node:diagnostics_channel'
import { afterEach, expect, test } from 'vitest'

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { YdbInstrumentation } from '../src/index.ts'

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

let active: YdbInstrumentation | undefined
afterEach(() => {
	active?.disable()
	active = undefined
	exporter.reset()
})

test('inherits driver identity from channel payload', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let exec = tracingChannel('tracing:ydb:query.execute')

	await exec.tracePromise(async () => {}, {
		driver: { database: '/db1', address: '10.0.0.1', port: 2136 },
		text: 'SELECT 1',
		sessionId: 's1',
		nodeId: 1n,
		idempotent: true,
		isolation: 'serializableReadWrite',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.ExecuteQuery')!
	expect(span.attributes['db.namespace']).toBe('/db1')
	expect(span.attributes['server.address']).toBe('10.0.0.1')
	expect(span.attributes['server.port']).toBe(2136)
})

test('attributes spans independently for parallel driver identities', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let exec = tracingChannel('tracing:ydb:query.execute')
	let baseCtx = {
		text: 'SELECT 1',
		nodeId: 1n,
		idempotent: true,
		isolation: 'serializableReadWrite',
	}

	await Promise.all([
		exec.tracePromise(async () => {}, {
			...baseCtx,
			sessionId: 'a',
			driver: { database: '/db1', address: '10.0.0.1', port: 2136 },
		}),
		exec.tracePromise(async () => {}, {
			...baseCtx,
			sessionId: 'b',
			driver: { database: '/db2', address: '10.0.0.2', port: 2136 },
		}),
	])

	let spans = exporter.getFinishedSpans().filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(spans).toHaveLength(2)

	let bySession = Object.fromEntries(spans.map((s) => [s.attributes['ydb.session.id'], s]))
	expect(bySession.a!.attributes['db.namespace']).toBe('/db1')
	expect(bySession.a!.attributes['server.address']).toBe('10.0.0.1')
	expect(bySession.b!.attributes['db.namespace']).toBe('/db2')
	expect(bySession.b!.attributes['server.address']).toBe('10.0.0.2')
})

test('omits server.address and db.namespace when payload has no driver', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let exec = tracingChannel('tracing:ydb:query.execute')
	await exec.tracePromise(async () => {}, {
		text: 'SELECT 1',
		sessionId: 's',
		nodeId: 1n,
		idempotent: true,
		isolation: 'serializableReadWrite',
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.ExecuteQuery')!
	expect(span.attributes['db.system.name']).toBe('ydb')
	expect(span.attributes['server.address']).toBeUndefined()
	expect(span.attributes['db.namespace']).toBeUndefined()
})
