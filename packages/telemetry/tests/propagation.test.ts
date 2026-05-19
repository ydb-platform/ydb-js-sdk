import { tracingChannel } from 'node:diagnostics_channel'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { YdbInstrumentation } from '../src/index.ts'

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

let instrumentation: YdbInstrumentation
beforeAll(() => {
	instrumentation = new YdbInstrumentation()
	instrumentation.enable()
})
afterAll(() => instrumentation.disable())
beforeEach(() => exporter.reset())

test('nests ExecuteQuery under Transaction', async () => {
	let tx = tracingChannel('tracing:ydb:query.transaction')
	let exec = tracingChannel('tracing:ydb:query.execute')

	await tx.tracePromise(
		async () => {
			await exec.tracePromise(async () => {}, {
				text: 'SELECT 1',
				sessionId: 's1',
				nodeId: 1n,
				idempotent: false,
				isolation: 'serializableReadWrite',
			})
		},
		{ isolation: 'serializableReadWrite', idempotent: false }
	)

	let spans = exporter.getFinishedSpans()
	let txSpan = spans.find((s) => s.name === 'ydb.Transaction')!
	let execSpan = spans.find((s) => s.name === 'ydb.ExecuteQuery')!
	expect(execSpan.parentSpanContext?.spanId).toBe(txSpan.spanContext().spanId)
})

test('nests CreateSession under Try under RunWithRetry', async () => {
	let run = tracingChannel('tracing:ydb:retry.run')
	let attempt = tracingChannel('tracing:ydb:retry.attempt')
	let create = tracingChannel('tracing:ydb:query.session.create')

	await run.tracePromise(
		async () => {
			await attempt.tracePromise(
				async () => {
					await create.tracePromise(async () => {}, {
						liveSessions: 0,
						maxSize: 50,
						creating: 1,
					})
				},
				{ attempt: 1, idempotent: true, backoffMs: 0 }
			)
		},
		{ idempotent: true }
	)

	let spans = exporter.getFinishedSpans()
	let runSpan = spans.find((s) => s.name === 'ydb.RunWithRetry')!
	let trySpan = spans.find((s) => s.name === 'ydb.Try')!
	let createSpan = spans.find((s) => s.name === 'ydb.CreateSession')!
	expect(trySpan.parentSpanContext?.spanId).toBe(runSpan.spanContext().spanId)
	expect(createSpan.parentSpanContext?.spanId).toBe(trySpan.spanContext().spanId)
})

test('keeps retry attempts as siblings under RunWithRetry', async () => {
	let run = tracingChannel('tracing:ydb:retry.run')
	let attempt = tracingChannel('tracing:ydb:retry.attempt')

	await run.tracePromise(
		async () => {
			await attempt.tracePromise(async () => {}, {
				attempt: 1,
				idempotent: true,
				backoffMs: 0,
			})
			await attempt.tracePromise(async () => {}, {
				attempt: 2,
				idempotent: true,
				backoffMs: 5,
			})
		},
		{ idempotent: true }
	)

	let spans = exporter.getFinishedSpans()
	let runSpan = spans.find((s) => s.name === 'ydb.RunWithRetry')!
	let tries = spans.filter((s) => s.name === 'ydb.Try')
	expect(tries).toHaveLength(2)
	for (let t of tries) expect(t.parentSpanContext?.spanId).toBe(runSpan.spanContext().spanId)
})

test('carries ydb.transaction.id on Commit span from txId field', async () => {
	let commit = tracingChannel('tracing:ydb:query.commit')
	await commit.tracePromise(async () => {}, {
		sessionId: 's1',
		nodeId: 1n,
		txId: 'tx-abc',
	})
	let spans = exporter.getFinishedSpans()
	let commitSpan = spans.find((s) => s.name === 'ydb.Commit')!
	expect(commitSpan.attributes['ydb.transaction.id']).toBe('tx-abc')
})

test('omits db.query.text by default', async () => {
	let exec = tracingChannel('tracing:ydb:query.execute')
	await exec.tracePromise(async () => {}, {
		text: 'SELECT secret FROM users',
		sessionId: 's1',
		nodeId: 1n,
		idempotent: false,
		isolation: 'serializableReadWrite',
	})
	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.ExecuteQuery')!
	expect(span.attributes['db.query.text']).toBeUndefined()
})

test('stamps db.system.name=ydb on every span', async () => {
	let exec = tracingChannel('tracing:ydb:query.execute')
	await exec.tracePromise(async () => {}, {
		text: 'SELECT 1',
		sessionId: 's1',
		nodeId: 1n,
		idempotent: true,
		isolation: 'serializableReadWrite',
	})
	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.ExecuteQuery')!
	expect(span.attributes['db.system.name']).toBe('ydb')
})

test('sets ERROR status and error.type on tracing channel error', async () => {
	let exec = tracingChannel('tracing:ydb:query.execute')
	await expect(
		exec.tracePromise(
			async () => {
				throw new Error('boom')
			},
			{
				text: 'SELECT 1',
				sessionId: 's1',
				nodeId: 1n,
				idempotent: false,
				isolation: 'serializableReadWrite',
			}
		)
	).rejects.toThrow('boom')

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.ExecuteQuery')!
	expect(span.status?.code).toBe(2)
	expect(span.attributes['error.type']).toBe('Error')
})

test('nests user span → tx → retry.run → retry.attempt → exec chain', async () => {
	let userTracer = trace.getTracer('test-app')
	let userSpan = userTracer.startSpan('checkout')

	let tx = tracingChannel('tracing:ydb:query.transaction')
	let run = tracingChannel('tracing:ydb:retry.run')
	let attempt = tracingChannel('tracing:ydb:retry.attempt')
	let exec = tracingChannel('tracing:ydb:query.execute')

	let driver = { database: '/local', address: '127.0.0.1', port: 2136 }

	await context.with(trace.setSpan(context.active(), userSpan), async () => {
		await tx.tracePromise(
			async () => {
				await run.tracePromise(
					async () => {
						await attempt.tracePromise(
							async () => {
								await exec.tracePromise(async () => {}, {
									driver,
									text: 'INSERT INTO orders ...',
									sessionId: 'sess-tx',
									nodeId: 7n,
									idempotent: false,
									isolation: 'serializableReadWrite',
								})
							},
							{ attempt: 1, idempotent: false, backoffMs: 0 }
						)
					},
					{ idempotent: false }
				)
			},
			{ driver, isolation: 'serializableReadWrite', idempotent: false }
		)
	})

	userSpan.end()

	let spans = exporter.getFinishedSpans()
	let user = spans.find((s) => s.name === 'checkout')!
	let txSpan = spans.find((s) => s.name === 'ydb.Transaction')!
	let runSpan = spans.find((s) => s.name === 'ydb.RunWithRetry')!
	let trySpan = spans.find((s) => s.name === 'ydb.Try')!
	let execSpan = spans.find((s) => s.name === 'ydb.ExecuteQuery')!

	// Topology: checkout → Transaction → RunWithRetry → Try → ExecuteQuery
	expect(txSpan.parentSpanContext?.spanId).toBe(user.spanContext().spanId)
	expect(runSpan.parentSpanContext?.spanId).toBe(txSpan.spanContext().spanId)
	expect(trySpan.parentSpanContext?.spanId).toBe(runSpan.spanContext().spanId)
	expect(execSpan.parentSpanContext?.spanId).toBe(trySpan.spanContext().spanId)

	// All spans in the chain share one traceId.
	let traceId = user.spanContext().traceId
	for (let s of [txSpan, runSpan, trySpan, execSpan]) {
		expect(s.spanContext().traceId).toBe(traceId)
	}

	// Identity carried only by spans whose payload includes `driver` (db-scoped
	// spans). Retry spans are generic and inherit identity through the trace
	// hierarchy, not attributes.
	for (let s of [txSpan, execSpan]) {
		expect(s.attributes['db.namespace']).toBe('/local')
		expect(s.attributes['server.address']).toBe('127.0.0.1')
	}
	for (let s of [runSpan, trySpan]) {
		expect(s.attributes['db.namespace']).toBeUndefined()
		expect(s.attributes['server.address']).toBeUndefined()
	}
})

test('records pool.connection.added as span event on active span', async () => {
	let { channel } = await import('node:diagnostics_channel')
	let tx = tracingChannel('tracing:ydb:query.transaction')

	await tx.tracePromise(
		async () => {
			channel('ydb:driver.connection.added').publish({
				nodeId: 7n,
				address: '10.0.0.1:2135',
				location: 'dc1',
			})
		},
		{ isolation: 'serializableReadWrite', idempotent: false }
	)

	let txSpan = exporter.getFinishedSpans().find((s) => s.name === 'ydb.Transaction')!
	let event = txSpan.events.find((e) => e.name === 'ydb.driver.connection.added')
	expect(event).toBeDefined()
	expect(event!.attributes?.['ydb.node.id']).toBe(7)
	expect(event!.attributes?.['ydb.node.dc']).toBe('dc1')
})

test('emits ydb.DeleteSession span with Query.DeleteSession operation and uptime in seconds', async () => {
	let del = tracingChannel('tracing:ydb:query.session.delete')

	// Payload `uptime` is in ms (Node convention); the OTel attribute should
	// be in seconds — that conversion lives in the telemetry mapping.
	await del.tracePromise(async () => {}, {
		sessionId: 'sess-42',
		nodeId: 3n,
		reason: 'pool_close',
		uptime: 2500,
	})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.DeleteSession')!
	expect(span).toBeDefined()
	expect(span.attributes['db.operation.name']).toBe('Query.DeleteSession')
	expect(span.attributes['ydb.session.id']).toBe('sess-42')
	expect(span.attributes['ydb.node.id']).toBe(3)
	expect(span.attributes['ydb.session.close.reason']).toBe('pool_close')
	expect(span.attributes['ydb.session.uptime']).toBe(2.5)
})

test('converts connection.pessimization durations from ms payload to seconds attribute', async () => {
	let { channel } = await import('node:diagnostics_channel')
	// Connection pool events naturally fire within a discovery round (pool
	// reshuffle is part of `Driver.runDiscoveryRound`), so the discovery span
	// is the natural carrier for their addEvent — not a transaction.
	let discovery = tracingChannel('tracing:ydb:driver.discovery')

	await discovery.tracePromise(async () => {
		channel('ydb:driver.connection.unpessimized').publish({
			nodeId: 9n,
			address: '10.0.0.2:2135',
			location: 'dc2',
			duration: 3000, // ms
		})
	}, {})

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.Discovery')!
	let event = span.events.find((e) => e.name === 'ydb.driver.connection.unpessimized')
	expect(event!.attributes?.['ydb.driver.connection.pessimization.duration']).toBe(3)
})
