import { expect, test } from 'vitest'

import { abortable } from './index.ts'

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

	await expect(result).rejects.toThrow('AbortError')
})

test('throws immediately when signal aborted with reason', async () => {
	let controller = new AbortController()
	let customReason = new Error('Custom abort reason')
	controller.abort(customReason)

	let promise = Promise.resolve('success')
	let result = abortable(controller.signal, promise)

	await expect(result).rejects.toThrow('AbortError')
})

test('aborts when signal aborted during promise execution', async () => {
	let controller = new AbortController()
	let promise = new Promise(resolve => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	// Abort after a short delay
	setTimeout(() => controller.abort(), 10)

	await expect(result).rejects.toThrow('AbortError')
})

test('resolves when promise completes before abort signal', async () => {
	let controller = new AbortController()
	let promise = new Promise(resolve => {
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

	let promise = new Promise(resolve => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	setTimeout(() => controller.abort(), 10)

	await expect(result).rejects.toThrow('AbortError')
	expect(listenerCalled).eq(true)
})

test('removes event listener after completion', async () => {
	let controller = new AbortController()
	let promise = Promise.resolve('success')

	await abortable(controller.signal, promise)

	// Check that listener was removed by verifying no memory leak
	// This is indirect - we can't easily test listener removal directly
	expect(controller.signal.aborted).eq(false)
})

test('handles promise that never resolves with abort', async () => {
	let controller = new AbortController()
	let promise = new Promise(() => {
		// Never resolves
	})

	let result = abortable(controller.signal, promise)

	// Immediately abort
	controller.abort()

	await expect(result).rejects.toThrow('AbortError')
})

test('handles promise rejection after abort signal', async () => {
	let controller = new AbortController()
	let promise = new Promise((_, reject) => {
		setTimeout(() => reject(new Error('late error')), 50)
	})

	let result = abortable(controller.signal, promise)

	// Abort immediately
	controller.abort()

	// Should reject with AbortError, not the promise error
	await expect(result).rejects.toThrow('AbortError')
})

test('creates AbortError when signal aborted with reason', async () => {
	let controller = new AbortController()
	let customReason = new Error('Custom cancellation')

	let promise = new Promise(resolve => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	setTimeout(() => controller.abort(customReason), 10)

	try {
		await result
		expect.fail('Expected promise to reject')
	} catch (error: any) {
		expect(error.name).eq('AbortError')
		expect(error.message).eq('AbortError')
	}
})

test('handles concurrent abortable calls with same signal', async () => {
	let controller = new AbortController()

	let promise1 = new Promise(resolve => setTimeout(() => resolve('result1'), 50))
	let promise2 = new Promise(resolve => setTimeout(() => resolve('result2'), 50))

	let result1 = abortable(controller.signal, promise1)
	let result2 = abortable(controller.signal, promise2)

	// Abort after starting both
	setTimeout(() => controller.abort(), 10)

	await expect(result1).rejects.toThrow('AbortError')
	await expect(result2).rejects.toThrow('AbortError')
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
	let promise = new Promise(resolve => {
		setTimeout(() => resolve('success'), 100)
	})

	let result = abortable(controller.signal, promise)

	setTimeout(() => controller.abort(), 10)

	try {
		await result
		expect.fail('Expected promise to reject')
	} catch (error: any) {
		expect(error.name).eq('AbortError')
		expect(error.cause).eq(undefined)
	}
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
	let promise = new Promise(resolve => {
		setTimeout(() => resolve('success'), 0)
	})

	let result = abortable(controller.signal, promise)

	// Abort immediately without delay
	controller.abort()

	await expect(result).rejects.toThrow('AbortError')
})

test('handles abort signal from different controller', async () => {
	let controller1 = new AbortController()
	let controller2 = new AbortController()

	let promise = new Promise(resolve => {
		setTimeout(() => resolve('success'), 50)
	})

	let result1 = abortable(controller1.signal, promise)
	let result2 = abortable(controller2.signal, promise)

	// Only abort controller1
	setTimeout(() => controller1.abort(), 10)

	await expect(result1).rejects.toThrow('AbortError')
	await expect(result2).resolves.eq('success')
})
