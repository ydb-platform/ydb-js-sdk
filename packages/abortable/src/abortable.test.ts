import { getEventListeners } from 'node:events'

import { expect, test } from 'vitest'

import { abortable } from './index.ts'

test('returns the original promise without a signal', async () => {
	let pending = Promise.withResolvers<string>()
	let result = abortable(undefined, pending.promise)

	expect(result).toBe(pending.promise)
	pending.resolve('success')
	await expect(result).resolves.toBe('success')
})

test('preserves a completed result when the signal aborts in the same turn', async () => {
	let controller = new AbortController()
	let result = abortable(controller.signal, Promise.resolve('success'))

	controller.abort(new Error('Cancelled after completion'))

	await expect(result).resolves.toBe('success')
})

test('preserves a completed rejection when the signal aborts in the same turn', async () => {
	let controller = new AbortController()
	let failure = new Error('Operation failed')
	let result = abortable(controller.signal, Promise.reject(failure))

	controller.abort(new Error('Cancelled after failure'))

	await expect(result).rejects.toBe(failure)
})

test('resolves when promise resolves before abort', async () => {
	let controller = new AbortController()
	let promise = Promise.resolve('success')

	let result = abortable(controller.signal, promise)

	await expect(result).resolves.eq('success')
})

test('rejects when promise rejects before abort', async () => {
	let controller = new AbortController()
	let error = new Error('promise error')
	let promise = Promise.reject(error)

	let result = abortable(controller.signal, promise)

	await expect(result).rejects.toThrow('promise error')
})

test('throws immediately when signal already aborted', async () => {
	let controller = new AbortController()
	controller.abort()

	let promise = Promise.resolve('success')
	let result = abortable(controller.signal, promise)

	await expect(result).rejects.toThrow('aborted')
})

test('throws immediately when signal aborted with reason', async () => {
	let controller = new AbortController()
	let customReason = new Error('Custom abort reason')
	controller.abort(customReason)

	let promise = Promise.resolve('success')
	let result = abortable(controller.signal, promise)

	await expect(result).rejects.toThrow('Custom abort reason')
})

test('observes a later rejection when the signal was already aborted', async () => {
	let pending = Promise.withResolvers<string>()
	let reason = new Error('Caller already cancelled')
	let result = abortable(AbortSignal.abort(reason), pending.promise)

	await expect(result).rejects.toBe(reason)
	pending.reject(new Error('Independent operation failed later'))
	await new Promise<void>((resolve) => setImmediate(resolve))
	await expect(result).rejects.toBe(reason)
})

test('aborts when signal aborted during promise execution', async () => {
	let controller = new AbortController()
	let promise = new Promise((resolve) => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	// 10ms abort fires well before the 100ms resolve, proving abort wins the race
	setTimeout(() => controller.abort(), 10)

	await expect(result).rejects.toThrow('aborted')
})

test('resolves when promise completes before abort signal', async () => {
	let controller = new AbortController()
	let promise = new Promise((resolve) => {
		setTimeout(() => resolve('fast result'), 10)
	})

	let result = abortable(controller.signal, promise)

	// Abort after promise should complete
	setTimeout(() => controller.abort(), 50)

	await expect(result).resolves.eq('fast result')
})

test('handles multiple abort listeners correctly', async () => {
	let controller = new AbortController()
	let listenerCalled = false

	// Add another listener to the signal
	controller.signal.addEventListener('abort', () => {
		listenerCalled = true
	})

	let promise = new Promise((resolve) => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	setTimeout(() => controller.abort(), 10)

	await expect(result).rejects.toThrow('aborted')
	expect(listenerCalled).eq(true)
})

test('removes event listener after completion', async () => {
	let controller = new AbortController()
	let promise = Promise.resolve('success')

	await abortable(controller.signal, promise)

	expect(getEventListeners(controller.signal, 'abort').length).eq(0)
})

test('handles promise that never resolves with abort', async () => {
	let controller = new AbortController()
	let promise = new Promise(() => {
		// Never resolves
	})

	let result = abortable(controller.signal, promise)

	// Immediately abort
	controller.abort()

	await expect(result).rejects.toThrow('aborted')
})

test('observes a later rejection after the caller cancels', async () => {
	let controller = new AbortController()
	let pending = Promise.withResolvers<string>()
	let reason = new Error('Caller cancelled')
	let result = abortable(controller.signal, pending.promise)

	controller.abort(reason)

	await expect(result).rejects.toBe(reason)
	expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
	pending.reject(new Error('Independent operation failed later'))
	await new Promise<void>((resolve) => setImmediate(resolve))
	await expect(result).rejects.toBe(reason)
})

test('rejects with reason when signal aborts during promise execution', async () => {
	let controller = new AbortController()
	let customReason = new Error('Custom cancellation')

	let promise = new Promise((resolve) => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	setTimeout(() => controller.abort(customReason), 10)

	await expect(result).rejects.toThrow('Custom cancellation')
})

test('handles concurrent abortable calls with same signal', async () => {
	let controller = new AbortController()

	let promise1 = new Promise((resolve) => setTimeout(() => resolve('result1'), 50))
	let promise2 = new Promise((resolve) => setTimeout(() => resolve('result2'), 50))

	let result1 = abortable(controller.signal, promise1)
	let result2 = abortable(controller.signal, promise2)

	// Abort must land while both calls are still in-flight, proving one shared
	// signal cancels multiple concurrent abortable() calls
	setTimeout(() => controller.abort(), 10)

	await expect(result1).rejects.toThrow('aborted')
	await expect(result2).rejects.toThrow('aborted')
})

test('works with different promise types', async () => {
	let controller = new AbortController()

	// Test with number
	let numberPromise = Promise.resolve(42)
	let numberResult = await abortable(controller.signal, numberPromise)
	expect(numberResult).eq(42)

	// Test with object
	let objPromise = Promise.resolve({ key: 'value' })
	let objResult = await abortable(controller.signal, objPromise)
	expect(objResult).toEqual({ key: 'value' })

	// Test with null
	let nullPromise = Promise.resolve(null)
	let nullResult = await abortable(controller.signal, nullPromise)
	expect(nullResult).eq(null)
})

test('handles abort without reason', async () => {
	let controller = new AbortController()
	let promise = new Promise((resolve) => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	setTimeout(() => controller.abort(), 10)

	await expect(result).rejects.toThrow('aborted')
})

test('handles promise that resolves to undefined', async () => {
	let controller = new AbortController()
	let promise = Promise.resolve(undefined)

	let result = await abortable(controller.signal, promise)

	expect(result).eq(undefined)
})

test('handles promise that resolves immediately', async () => {
	let controller = new AbortController()
	let promise = Promise.resolve('immediate')

	let result = await abortable(controller.signal, promise)

	expect(result).eq('immediate')
})

test('handles extremely fast abort timing', async () => {
	let controller = new AbortController()
	let promise = new Promise((resolve) => {
		setTimeout(() => resolve('success'), 0)
	})

	let result = abortable(controller.signal, promise)

	// Abort immediately without delay
	controller.abort()

	await expect(result).rejects.toThrow('aborted')
})

test('cancels one caller without cancelling another wait for the same promise', async () => {
	let first = new AbortController()
	let second = new AbortController()
	let pending = Promise.withResolvers<string>()
	let reason = new Error('First caller cancelled')
	let firstResult = abortable(first.signal, pending.promise)
	let secondResult = abortable(second.signal, pending.promise)

	first.abort(reason)
	await expect(firstResult).rejects.toBe(reason)
	expect(second.signal.aborted).toBe(false)

	pending.resolve('success')
	await expect(secondResult).resolves.toBe('success')
	expect(getEventListeners(first.signal, 'abort')).toHaveLength(0)
	expect(getEventListeners(second.signal, 'abort')).toHaveLength(0)
})

test('removes the abort listener when the operation rejects', async () => {
	let controller = new AbortController()
	let failure = new Error('Operation failed')
	let result = abortable(controller.signal, Promise.reject(failure))

	await expect(result).rejects.toBe(failure)
	expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})
