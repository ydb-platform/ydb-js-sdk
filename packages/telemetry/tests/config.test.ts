import { tracingChannel } from 'node:diagnostics_channel'
import { afterEach, beforeAll, expect, test } from 'vitest'

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

beforeAll(() => exporter.reset())

async function fireExecute() {
	let exec = tracingChannel('tracing:ydb:query.execute')
	await exec.tracePromise(async () => {}, {
		text: 'SELECT 1',
		sessionId: 's1',
		nodeId: 1n,
		idempotent: true,
		isolation: 'serializableReadWrite',
	})
}

test('omits ydb.AcquireSession span by default', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let acq = tracingChannel('tracing:ydb:query.session.acquire')
	await acq.tracePromise(async () => {}, {})

	expect(exporter.getFinishedSpans().some((s) => s.name === 'ydb.AcquireSession')).toBe(false)
})

test('emits ydb.AcquireSession span when emitAcquireSessionSpan is true', async () => {
	active = new YdbInstrumentation({ emitAcquireSessionSpan: true })
	active.enable()

	let acq = tracingChannel('tracing:ydb:query.session.acquire')
	await acq.tracePromise(async () => {}, {})

	expect(exporter.getFinishedSpans().some((s) => s.name === 'ydb.AcquireSession')).toBe(true)
})

test('exposes raw query text when captureQueryText is true', async () => {
	active = new YdbInstrumentation({ captureQueryText: true })
	active.enable()

	await fireExecute()

	let span = exporter.getFinishedSpans().find((s) => s.name === 'ydb.ExecuteQuery')!
	expect(span.attributes['db.query.text']).toBe('SELECT 1')
})

test('does not double-subscribe on repeated enable calls', async () => {
	active = new YdbInstrumentation()
	active.enable()
	active.enable()

	await fireExecute()
	let spans = exporter.getFinishedSpans().filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(spans).toHaveLength(1)
})

test('reattaches subscribers after disable then enable', async () => {
	active = new YdbInstrumentation()
	active.enable()
	active.disable()
	active.enable()

	await fireExecute()
	let spans = exporter.getFinishedSpans().filter((s) => s.name === 'ydb.ExecuteQuery')
	expect(spans).toHaveLength(1)
})
