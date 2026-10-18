import { expect, test, vi } from 'vitest'

import { createDeadline } from './deadline.js'
import { RpcError, Status } from './error.js'

test('leaves an absent or infinite deadline disabled', () => {
	expect(createDeadline()).toBeUndefined()
	expect(createDeadline(Infinity)).toBeUndefined()
})

test.each([NaN, new Date(NaN)])('rejects an invalid deadline %s', (value) => {
	expect(() => createDeadline(value)).toThrow(RangeError)
})

test('expires an elapsed deadline synchronously', () => {
	using deadline = createDeadline(Date.now() - 1)
	expect(deadline?.signal.aborted).toBe(true)
	expect(deadline?.signal.reason).toBeInstanceOf(RpcError)
	expect(deadline?.signal.reason).toMatchObject({ code: Status.DEADLINE_EXCEEDED })
})

test('expires at an absolute Date deadline', (tc) => {
	vi.useFakeTimers()
	tc.onTestFinished(() => vi.useRealTimers())
	using deadline = createDeadline(new Date(Date.now() + 100))

	vi.advanceTimersByTime(99)
	expect(deadline?.signal.aborted).toBe(false)
	vi.advanceTimersByTime(1)
	expect(deadline?.signal.reason).toMatchObject({ code: Status.DEADLINE_EXCEEDED })
})

test('keeps a far-future deadline pending beyond the timer limit', (tc) => {
	vi.useFakeTimers()
	tc.onTestFinished(() => vi.useRealTimers())
	using deadline = createDeadline(Date.now() + 2147483647 + 100)

	vi.advanceTimersByTime(2147483647)
	expect(deadline?.signal.aborted).toBe(false)
	vi.advanceTimersByTime(100)
	expect(deadline?.signal.reason).toMatchObject({ code: Status.DEADLINE_EXCEEDED })
})

test('disposing cancels expiry without aborting the signal', (tc) => {
	vi.useFakeTimers()
	tc.onTestFinished(() => vi.useRealTimers())
	using deadline = createDeadline(Date.now() + 100)
	deadline?.[Symbol.dispose]()
	deadline?.[Symbol.dispose]()

	vi.advanceTimersByTime(1000)
	expect(deadline?.signal.aborted).toBe(false)
	expect(deadline?.signal.reason).toBeUndefined()
})
