import { afterAll, beforeAll, expect, test } from 'vitest'

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { retry } from '../../retry/src/index.ts'

import { subscribe } from '../src/subscribe.ts'

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

test('ydb.Try has ydb.retry.backoff_ms for the attempt that follows a sleep', async () => {
	exporter.reset()

	let calls = 0
	await retry({ retry: true, budget: 3, strategy: 80, idempotent: true }, async () => {
		calls++
		if (calls < 2) throw new Error('again')
		return 'ok'
	})

	let spans = exporter.getFinishedSpans()
	let trySpans = spans
		.filter((s) => s.name === 'ydb.Try')
		.sort((a, b) =>
			a.startTime[0] - b.startTime[0]
				? a.startTime[0] - b.startTime[0]
				: a.startTime[1] - b.startTime[1]
		)

	expect(trySpans.length).toBeGreaterThanOrEqual(2)
	expect(trySpans[0]!.attributes['ydb.retry.attempt']).toBe(1)
	expect(trySpans[0]!.attributes['ydb.retry.backoff_ms']).toBe(0)
	expect(trySpans[1]!.attributes['ydb.retry.attempt']).toBe(2)
	expect(Number(trySpans[1]!.attributes['ydb.retry.backoff_ms'])).toBeGreaterThan(0)
})

test('cancel during backoff marks ydb.RunWithRetry span as CANCELLED', async () => {
	exporter.reset()

	let ac = new AbortController()
	let p = retry(
		{ retry: true, budget: 10, strategy: 1000, idempotent: false, signal: ac.signal },
		async () => {
			throw new Error('again')
		}
	)

	setTimeout(() => ac.abort(), 20)

	await expect(p).rejects.toMatchObject({ name: 'AbortError' })

	let spans = exporter.getFinishedSpans()
	let run = spans.find((s) => s.name === 'ydb.RunWithRetry')
	expect(run).toBeDefined()
	expect(run!.attributes['db.response.status_code']).toBe('CANCELLED')
	expect(run!.attributes['error.type']).toBe('CANCELLED')
})
