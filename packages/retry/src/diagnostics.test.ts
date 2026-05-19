import { expect, test } from 'vitest'
import { channel as dc, tracingChannel } from 'node:diagnostics_channel'

import { retry } from './index.js'

/** Subscribe to a plain channel; returned object is `Disposable`. */
function collect(name: string): { payloads: unknown[] } & Disposable {
	let payloads: unknown[] = []
	let fn = (msg: unknown) => payloads.push(structuredClone(msg))
	dc(name).subscribe(fn)
	return {
		payloads,
		[Symbol.dispose]() {
			dc(name).unsubscribe(fn)
		},
	}
}

/** Subscribe to a tracing channel; capture start / asyncEnd / error contexts. */
function collectTrace(name: string): {
	start: object[]
	asyncEnd: object[]
	error: (object & { error: unknown })[]
} & Disposable {
	let ch = tracingChannel(name)
	let start: object[] = []
	let asyncEnd: object[] = []
	let error: (object & { error: unknown })[] = []
	let handlers = {
		start: (ctx: any) => start.push({ ...ctx }),
		asyncEnd: (ctx: any) => asyncEnd.push({ ...ctx }),
		error: (ctx: any) => error.push({ ...ctx }),
	}
	ch.subscribe(handlers as any)
	return {
		start,
		asyncEnd,
		error,
		[Symbol.dispose]() {
			ch.unsubscribe(handlers as any)
		},
	}
}

// ── retry.run ────────────────────────────────────────────────────────────────

test('traces tracing:ydb:retry.run start and asyncEnd around a successful call', async () => {
	using trace = collectTrace('tracing:ydb:retry.run')

	let result = await retry({ idempotent: true }, async () => 42)

	expect(result).toBe(42)
	expect(trace.start).toHaveLength(1)
	expect(trace.asyncEnd).toHaveLength(1)
	expect(trace.error).toHaveLength(0)
	expect(trace.start[0]).toMatchObject({ idempotent: true })
})

test('traces tracing:ydb:retry.run error when retries are exhausted', async () => {
	using trace = collectTrace('tracing:ydb:retry.run')

	await expect(
		retry({ budget: 1, retry: false, idempotent: false }, () => {
			throw new Error('nope')
		})
	).rejects.toThrow('nope')

	expect(trace.start).toHaveLength(1)
	expect(trace.error).toHaveLength(1)
	expect(trace.error[0]?.error).toBeInstanceOf(Error)
})

// ── retry.attempt ────────────────────────────────────────────────────────────

test('publishes tracing:ydb:retry.attempt once per attempt with monotonic numbers', async () => {
	using trace = collectTrace('tracing:ydb:retry.attempt')

	let calls = 0
	let result = await retry(
		{ retry: true, budget: 5, strategy: 0, idempotent: false },
		async () => {
			calls++
			if (calls < 3) throw new Error('again')
			return 'ok'
		}
	)

	expect(result).toBe('ok')
	expect(trace.start).toHaveLength(3)
	expect(trace.start.map((c: any) => c.attempt)).toEqual([1, 2, 3])
	expect(trace.asyncEnd).toHaveLength(3)
	// First two attempts fail → error fires twice
	expect(trace.error).toHaveLength(2)
})

test('tracing:ydb:retry.attempt ctx carries backoffMs (0 for first, >0 after a delayed retry)', async () => {
	using trace = collectTrace('tracing:ydb:retry.attempt')

	let calls = 0
	await retry(
		// strategy: 25ms — first failure waits ~25ms before the second attempt
		{ retry: true, budget: 5, strategy: 25, idempotent: false },
		async () => {
			calls++
			if (calls < 2) throw new Error('again')
			return 'ok'
		}
	)

	expect(trace.start).toHaveLength(2)
	let [first, second] = trace.start as Array<{ attempt: number; backoffMs: number }>
	expect(first.attempt).toBe(1)
	expect(first.backoffMs).toBe(0)
	expect(second.attempt).toBe(2)
	expect(second.backoffMs).toBeGreaterThan(0)
	expect(second.backoffMs).toBeLessThanOrEqual(25)
})

// ── retry.exhausted ──────────────────────────────────────────────────────────

test('publishes ydb:retry.exhausted with attempts, duration and lastError when budget runs out', async () => {
	using exhausted = collect('ydb:retry.exhausted')

	let err = new Error('done')
	await expect(
		retry({ retry: true, budget: 2, strategy: 0, idempotent: false }, () => {
			throw err
		})
	).rejects.toBe(err)

	expect(exhausted.payloads).toHaveLength(1)
	let p = exhausted.payloads[0] as any
	expect(p.attempts).toBe(2)
	expect(typeof p.totalDuration).toBe('number')
	expect(p.totalDuration).toBeGreaterThanOrEqual(0)
	expect(p.lastError).toBeInstanceOf(Error)
})

test('skips ydb:retry.exhausted when the call succeeds', async () => {
	using exhausted = collect('ydb:retry.exhausted')

	await retry({ idempotent: true }, async () => 'ok')

	expect(exhausted.payloads).toHaveLength(0)
})

// ── retry.attempt.completed ──────────────────────────────────────────────────

test('emits attempt.completed with outcome=success on first-try success', async () => {
	using completed = collect('ydb:retry.attempt.completed')

	await retry({ idempotent: true }, async () => 'ok')

	expect(completed.payloads).toHaveLength(1)
	expect(completed.payloads[0]).toMatchObject({
		attempt: 1,
		idempotent: true,
		outcome: 'success',
	})
})

test('emits attempt.completed sequence: retried, retried, success', async () => {
	using completed = collect('ydb:retry.attempt.completed')

	let calls = 0
	await retry({ retry: true, budget: 5, strategy: 0, idempotent: false }, async () => {
		calls++
		if (calls < 3) throw new Error('again')
		return 'ok'
	})

	expect(completed.payloads).toHaveLength(3)
	expect(completed.payloads.map((p: any) => p.outcome)).toEqual(['retried', 'retried', 'success'])
})

test('emits attempt.completed with outcome=exhausted when budget runs out', async () => {
	using completed = collect('ydb:retry.attempt.completed')

	await expect(
		retry({ retry: true, budget: 2, strategy: 0, idempotent: true }, () => {
			throw new Error('fail')
		})
	).rejects.toThrow('fail')

	expect(completed.payloads).toHaveLength(2)
	expect(completed.payloads.map((p: any) => p.outcome)).toEqual(['retried', 'exhausted'])
})

test('emits attempt.completed with outcome=non_retryable on first non-retryable error', async () => {
	using completed = collect('ydb:retry.attempt.completed')

	await expect(
		retry({ retry: false, budget: 5, idempotent: true }, () => {
			throw new Error('nope')
		})
	).rejects.toThrow('nope')

	expect(completed.payloads).toHaveLength(1)
	expect(completed.payloads[0]).toMatchObject({
		attempt: 1,
		outcome: 'non_retryable',
	})
})

test('tracing:ydb:retry.run.asyncEnd carries outcome=success when the call resolves', async () => {
	using trace = collectTrace('tracing:ydb:retry.run')

	await retry({ idempotent: true }, async () => 'ok')

	expect(trace.asyncEnd).toHaveLength(1)
	expect(trace.asyncEnd[0]).toMatchObject({ outcome: 'success' })
})

test('tracing:ydb:retry.run.error carries outcome=exhausted when budget runs out', async () => {
	using trace = collectTrace('tracing:ydb:retry.run')

	await expect(
		retry({ retry: true, budget: 1, strategy: 0, idempotent: false }, () => {
			throw new Error('fail')
		})
	).rejects.toThrow('fail')

	expect(trace.error).toHaveLength(1)
	expect(trace.error[0]).toMatchObject({ outcome: 'exhausted' })
})
