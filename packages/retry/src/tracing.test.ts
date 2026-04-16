import { expect, test, vi } from 'vitest'

import { retry } from './index.ts'
import type { RetrySpan, RetryTracer } from './config.ts'

function makeTracer() {
	const spans: {
		name: string
		opts?: { kind?: number }
		attributes: Record<string, string | number | boolean>
		exceptions: Error[]
		status: { code: number; message?: string } | null
		ended: boolean
	}[] = []

	const tracer: RetryTracer = {
		startSpan(name: string, opts?: { kind?: number }): RetrySpan {
			const spanRecord = {
				name,
				opts,
				attributes: {} as Record<string, string | number | boolean>,
				exceptions: [] as Error[],
				status: null as { code: number; message?: string } | null,
				ended: false,
			}
			spans.push(spanRecord)
			const span: RetrySpan = {
				setAttribute(key, value) {
					spanRecord.attributes[key] = value
				},
				recordException(error) {
					spanRecord.exceptions.push(error)
				},
				setStatus(s) {
					spanRecord.status = s
				},
				end() {
					spanRecord.ended = true
				},
				runInContext<T>(fn: () => T): T {
					return fn()
				},
			}
			return span
		},
	}

	return { tracer, spans }
}

test('creates ydb.RunWithRetry span wrapping successful operation', async () => {
	const { tracer, spans } = makeTracer()

	await retry({ retry: false, budget: 1, tracer }, async () => 'ok')

	const run = spans.find((s) => s.name === 'ydb.RunWithRetry')
	expect(run).toBeDefined()
	expect(run!.ended).toBe(true)
	expect(run!.status).toBeNull()
})

test('creates ydb.Try span for each attempt', async () => {
	const { tracer, spans } = makeTracer()
	let attempts = 0

	await retry({ retry: (e) => e instanceof Error, budget: 5, strategy: 0, tracer }, async () => {
		attempts++
		if (attempts < 3) throw new Error(`fail ${attempts}`)
		return 'ok'
	})

	const trySpans = spans.filter((s) => s.name === 'ydb.Try')
	expect(trySpans).toHaveLength(3)
})

test('ydb.Try span has kind INTERNAL (0)', async () => {
	const { tracer, spans } = makeTracer()

	await retry({ retry: false, budget: 1, tracer }, async () => 'ok')

	const trySpan = spans.find((s) => s.name === 'ydb.Try')
	expect(trySpan).toBeDefined()
	expect(trySpan!.opts?.kind).toBe(0)
})

test('ydb.RunWithRetry span has kind INTERNAL (0)', async () => {
	const { tracer, spans } = makeTracer()

	await retry({ retry: false, budget: 1, tracer }, async () => 'ok')

	const runSpan = spans.find((s) => s.name === 'ydb.RunWithRetry')
	expect(runSpan!.opts?.kind).toBe(0)
})

test('failed ydb.Try span records exception and sets error status', async () => {
	const { tracer, spans } = makeTracer()
	let attempts = 0

	await retry({ retry: (e) => e instanceof Error, budget: 5, strategy: 0, tracer }, async () => {
		attempts++
		if (attempts === 1) throw new Error('transient error')
		return 'ok'
	})

	const failedTry = spans.filter((s) => s.name === 'ydb.Try')[0]!
	expect(failedTry.exceptions).toHaveLength(1)
	expect(failedTry.exceptions[0]!.message).toBe('transient error')
	expect(failedTry.status?.code).toBe(2)
	expect(failedTry.ended).toBe(true)
})

test('successful ydb.Try span has no exception and no error status', async () => {
	const { tracer, spans } = makeTracer()

	await retry({ retry: false, budget: 1, tracer }, async () => 'ok')

	const successTry = spans.filter((s) => s.name === 'ydb.Try').at(-1)!
	expect(successTry.exceptions).toHaveLength(0)
	expect(successTry.status).toBeNull()
	expect(successTry.ended).toBe(true)
})

test('ydb.Try span records ydb.retry.backoff_ms attribute equal to sleep duration', async () => {
	const { tracer, spans } = makeTracer()
	let attempts = 0

	await retry({ retry: (e) => e instanceof Error, budget: 5, strategy: 50, tracer }, async () => {
		attempts++
		if (attempts === 1) throw new Error('transient')
		return 'ok'
	})

	const failedTry = spans.filter((s) => s.name === 'ydb.Try')[0]!
	expect(failedTry.attributes['ydb.retry.backoff_ms']).toBeGreaterThanOrEqual(0)
})

test('ydb.RunWithRetry uses custom spanName when provided', async () => {
	const { tracer, spans } = makeTracer()

	await retry({ retry: false, budget: 1, tracer, spanName: 'custom.op' }, async () => 'ok')

	expect(spans.find((s) => s.name === 'custom.op')).toBeDefined()
	expect(spans.find((s) => s.name === 'ydb.RunWithRetry')).toBeUndefined()
})

test('ydb.RunWithRetry span records exception and error status when all retries fail', async () => {
	const { tracer, spans } = makeTracer()
	const err = new Error('permanent failure')

	await expect(
		retry({ retry: false, budget: 1, tracer }, async () => {
			throw err
		})
	).rejects.toThrow('permanent failure')

	const runSpan = spans.find((s) => s.name === 'ydb.RunWithRetry')!
	expect(runSpan.exceptions).toHaveLength(1)
	expect(runSpan.status?.code).toBe(2)
	expect(runSpan.ended).toBe(true)
})

test('context.cancel (AbortError) ends ydb.Try span with error and rethrows', async () => {
	const { tracer, spans } = makeTracer()

	const abortError = Object.assign(new Error('operation cancelled by context'), {
		name: 'AbortError',
	})

	await expect(
		retry({ retry: true, budget: 5, tracer }, async () => {
			throw abortError
		})
	).rejects.toMatchObject({ name: 'AbortError' })

	const trySpan = spans.find((s) => s.name === 'ydb.Try')!
	expect(trySpan.status?.code).toBe(2)
	expect(trySpan.exceptions).toHaveLength(1)
	expect(trySpan.ended).toBe(true)
})

test('context.cancel via pre-aborted signal immediately fails with RunWithRetry error span', async () => {
	const { tracer, spans } = makeTracer()
	const ac = new AbortController()
	ac.abort()

	await expect(
		retry({ retry: true, budget: 5, tracer, signal: ac.signal }, async () => 'ok')
	).rejects.toThrow('This operation was aborted')

	const runSpan = spans.find((s) => s.name === 'ydb.RunWithRetry')!
	expect(runSpan).toBeDefined()
	expect(runSpan.status?.code).toBe(2)
	expect(runSpan.ended).toBe(true)
})

test('no spans created when tracer is not provided', async () => {
	const { spans } = makeTracer()
	const result = await retry({ retry: false, budget: 1 }, async () => 'ok')
	expect(result).toBe('ok')
	expect(spans).toHaveLength(0)
})

test('all ydb.Try spans are ended even after non-retryable error', async () => {
	const { tracer, spans } = makeTracer()

	await expect(
		retry({ retry: false, budget: 3, tracer }, async () => {
			throw new Error('not retryable')
		})
	).rejects.toThrow('not retryable')

	const trySpans = spans.filter((s) => s.name === 'ydb.Try')
	expect(trySpans).toHaveLength(1)
	expect(trySpans.every((s) => s.ended)).toBe(true)
})

test('runInContext is called so child spans can be nested inside ydb.Try', async () => {
	const runInContextCalls: string[] = []

	const tracer: RetryTracer = {
		startSpan(name) {
			return {
				setAttribute: vi.fn(),
				recordException: vi.fn(),
				setStatus: vi.fn(),
				end: vi.fn(),
				runInContext<T>(fn: () => T): T {
					runInContextCalls.push(name)
					return fn()
				},
			}
		},
	}

	await retry({ retry: false, budget: 1, tracer }, async () => 'ok')

	expect(runInContextCalls).toContain('ydb.RunWithRetry')
	expect(runInContextCalls).toContain('ydb.Try')
})
