import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'

import { RateLimiter } from './rate-limiter.ts'

// Timer overshoot and long event-loop pauses cannot be scheduled deterministically.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }))

test('preserves the requested rate across repeated timer overshoot', async (tc) => {
	let clock = 1000
	using _now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
	vi.mocked(setTimeout).mockImplementation(async (delay) => {
		clock += delay! + 0.2
	})
	let limiter = new RateLimiter(500)
	let signal = tc.signal
	for (let i = 0; i < 1000; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await limiter.wait(signal)
		clock += 0.1
	}
	expect(clock - 1000).toBeGreaterThan(1990)
	expect(clock - 1000).toBeLessThan(2001)
})

test('bounds catchup after an event-loop pause and preserves cancellation', async () => {
	let clock = 1000
	using _now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
	vi.mocked(setTimeout).mockImplementation(async (delay) => {
		clock += delay!
	})
	let limiter = new RateLimiter(500)
	let controller = new AbortController()
	await limiter.wait(controller.signal)
	clock = 100_000
	for (let i = 0; i < 10; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await limiter.wait(controller.signal)
	}
	expect(clock).toBeGreaterThanOrEqual(100_016)
	controller.abort(new Error('stop workload'))
	await expect(limiter.wait(controller.signal)).rejects.toThrow('stop workload')
})
