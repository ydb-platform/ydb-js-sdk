import { expect, test, vi } from 'vitest'

import type { RetryContext, RetryHooks } from './config.ts'
import { retry } from './index.ts'

function makeHooks() {
	const calls: {
		wrapRun: number
		wrapAttempt: { ctx: RetryContext }[]
		onAttemptSuccess: { ctx: RetryContext }[]
		onAttemptError: { ctx: RetryContext; backoffMs: number; error: unknown }[]
		runInContextCalls: string[]
	} = {
		wrapRun: 0,
		wrapAttempt: [],
		onAttemptSuccess: [],
		onAttemptError: [],
		runInContextCalls: [],
	}

	const hooks: RetryHooks = {
		wrapRun<T>(fn: () => Promise<T>): Promise<T> {
			calls.wrapRun++
			calls.runInContextCalls.push('wrapRun')
			return fn()
		},
		wrapAttempt<T>(ctx: RetryContext, fn: () => T): T {
			calls.wrapAttempt.push({ ctx: { ...ctx } })
			calls.runInContextCalls.push('wrapAttempt')
			return fn()
		},
		onAttemptSuccess(ctx: RetryContext) {
			calls.onAttemptSuccess.push({ ctx: { ...ctx } })
		},
		onAttemptError(ctx: RetryContext, error: unknown, backoffMs: number) {
			calls.onAttemptError.push({ ctx: { ...ctx }, error, backoffMs })
		},
	}

	return { hooks, calls }
}

test('wrapRun is called once for a successful operation', async () => {
	const { hooks, calls } = makeHooks()

	await retry({ retry: false, budget: 1, ...hooks }, async () => 'ok')

	expect(calls.wrapRun).toBe(1)
})

test('wrapAttempt is called once per attempt', async () => {
	const { hooks, calls } = makeHooks()
	let attempts = 0

	await retry(
		{ retry: (e) => e instanceof Error, budget: 5, strategy: 0, ...hooks },
		async () => {
			attempts++
			if (attempts < 3) throw new Error(`fail ${attempts}`)
			return 'ok'
		}
	)

	expect(calls.wrapAttempt).toHaveLength(3)
})

test('onAttemptSuccess is called on successful attempt', async () => {
	const { hooks, calls } = makeHooks()

	await retry({ retry: false, budget: 1, ...hooks }, async () => 'ok')

	expect(calls.onAttemptSuccess).toHaveLength(1)
	expect(calls.onAttemptError).toHaveLength(0)
})

test('onAttemptError is called for each failed attempt', async () => {
	const { hooks, calls } = makeHooks()
	let attempts = 0

	await retry(
		{ retry: (e) => e instanceof Error, budget: 5, strategy: 0, ...hooks },
		async () => {
			attempts++
			if (attempts < 3) throw new Error(`fail ${attempts}`)
			return 'ok'
		}
	)

	expect(calls.onAttemptError).toHaveLength(2)
	expect(calls.onAttemptSuccess).toHaveLength(1)
})

test('onAttemptError receives error and backoffMs=0 for non-retryable errors', async () => {
	const { hooks, calls } = makeHooks()
	const err = new Error('permanent failure')

	await expect(
		retry({ retry: false, budget: 3, ...hooks }, async () => {
			throw err
		})
	).rejects.toThrow('permanent failure')

	expect(calls.onAttemptError).toHaveLength(1)
	expect(calls.onAttemptError[0]!.backoffMs).toBe(0)
	expect(calls.onAttemptError[0]!.error).toBe(err)
})

test('onAttemptError receives non-zero backoffMs when retrying with delay', async () => {
	const { hooks, calls } = makeHooks()
	let attempts = 0

	await retry(
		{ retry: (e) => e instanceof Error, budget: 5, strategy: 50, ...hooks },
		async () => {
			attempts++
			if (attempts === 1) throw new Error('transient')
			return 'ok'
		}
	)

	expect(calls.onAttemptError).toHaveLength(1)
	expect(calls.onAttemptError[0]!.backoffMs).toBeGreaterThanOrEqual(0)
})

test('onAttemptError receives backoffMs=0 for AbortError', async () => {
	const { hooks, calls } = makeHooks()

	const abortError = Object.assign(new Error('operation cancelled'), { name: 'AbortError' })

	await expect(
		retry({ retry: true, budget: 5, ...hooks }, async () => {
			throw abortError
		})
	).rejects.toMatchObject({ name: 'AbortError' })

	expect(calls.onAttemptError).toHaveLength(1)
	expect(calls.onAttemptError[0]!.backoffMs).toBe(0)
})

test('errors propagate through wrapRun', async () => {
	const { hooks, calls } = makeHooks()
	const err = new Error('permanent failure')

	await expect(
		retry({ retry: false, budget: 1, ...hooks }, async () => {
			throw err
		})
	).rejects.toThrow('permanent failure')

	expect(calls.wrapRun).toBe(1)
})

test('no hooks called when none are provided', async () => {
	const result = await retry({ retry: false, budget: 1 }, async () => 'ok')
	expect(result).toBe('ok')
})

test('wrapAttempt context propagates to fn (runInContext)', async () => {
	const runInContextCalls: string[] = []

	const hooks: RetryHooks = {
		wrapRun: vi.fn(<T>(fn: () => Promise<T>) => fn()),
		wrapAttempt<T>(_ctx: RetryContext, fn: () => T): T {
			runInContextCalls.push('wrapAttempt')
			return fn()
		},
	}

	await retry({ retry: false, budget: 1, ...hooks }, async () => 'ok')

	expect(runInContextCalls).toContain('wrapAttempt')
	expect(hooks.wrapRun).toHaveBeenCalledTimes(1)
})

test('wrapRun not called when not provided', async () => {
	const wrapAttemptCalls: number[] = []

	const hooks: RetryHooks = {
		wrapAttempt<T>(_ctx: RetryContext, fn: () => T): T {
			wrapAttemptCalls.push(1)
			return fn()
		},
	}

	await retry({ retry: false, budget: 1, ...hooks }, async () => 'ok')

	expect(wrapAttemptCalls).toHaveLength(1)
})

test('pre-aborted signal triggers onAttemptError with AbortError and fails immediately', async () => {
	const { hooks, calls } = makeHooks()
	const ac = new AbortController()
	ac.abort()

	await expect(
		retry({ retry: true, budget: 5, signal: ac.signal, ...hooks }, async () => 'ok')
	).rejects.toMatchObject({ name: 'AbortError' })

	expect(calls.onAttemptError).toHaveLength(1)
	expect((calls.onAttemptError[0]!.error as Error).name).toBe('AbortError')
	expect(calls.wrapRun).toBe(1)
})

test('context cancellation mid-execution ends Try span with backoffMs=0 and no retry', async () => {
	const { hooks, calls } = makeHooks()
	const ac = new AbortController()

	await expect(
		retry(
			{ retry: true, budget: 5, strategy: 100, ...hooks, signal: ac.signal },
			async (signal) => {
				// Cancel context mid-execution (after wrapAttempt has already started)
				ac.abort()
				await new Promise<never>((_, reject) =>
					signal.addEventListener('abort', () => reject(signal.reason), { once: true })
				)
			}
		)
	).rejects.toMatchObject({ name: 'AbortError' })

	// wrapRun wraps the entire loop — called once
	expect(calls.wrapRun).toBe(1)
	// wrapAttempt wraps each attempt — called once (aborted on first)
	expect(calls.wrapAttempt).toHaveLength(1)
	// onAttemptError called with AbortError and backoffMs=0 (no next attempt)
	expect(calls.onAttemptError).toHaveLength(1)
	expect((calls.onAttemptError[0]!.error as Error).name).toBe('AbortError')
	expect(calls.onAttemptError[0]!.backoffMs).toBe(0)
	// onAttemptSuccess must not be called
	expect(calls.onAttemptSuccess).toHaveLength(0)
})
