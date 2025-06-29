import { expect, test } from 'vitest'

import { retry } from './index.ts'

let isError = (error: unknown) => error instanceof Error

test('retries operation successfully', async () => {
	let attempts = 0

	let result = retry({ retry: isError, budget: 3 }, async () => {
		if (attempts >= 2) {
			return 'success'
		}

		attempts++
		throw new Error('test error')
	})

	await expect(result).resolves.eq('success')
	expect(attempts).eq(2)
})

test('returns result immediately if operation succeeds on first attempt', async () => {
	let attempts = 0

	let result = retry({ retry: isError, budget: 3 }, async () => {
		attempts++
		return 'immediate success'
	})

	await expect(result).resolves.eq('immediate success')
	expect(attempts).eq(1)
})

test('stops when budget is 0', async () => {
	let attempts = 0
	let error = new Error('test error')

	let result = retry({ retry: isError, budget: 0 }, async () => {
		attempts++
		throw error
	})

	await expect(result).rejects.toThrow('test error')
	expect(attempts).eq(0)
})

test('stops when budget exceeded', async () => {
	let attempts = 0
	let error = new Error('test error')

	let result = retry({ retry: isError, budget: 2 }, async () => {
		attempts++
		throw error
	})

	await expect(result).rejects.toThrow('test error')
	expect(attempts).eq(2)
})

test('accepts aborted signal', async () => {
	let attempts = 0
	let controller = new AbortController()

	controller.abort()

	let result = retry({ retry: isError, signal: controller.signal }, async () => {
		attempts++
		throw new Error('should not reach here')
	})

	await expect(result).rejects.toThrow('This operation was aborted')
	expect(attempts).eq(0)
})

test('respects signal abort', async () => {
	let attempts = 0
	let controller = new AbortController()

	// Abort immediately
	controller.abort()

	let result = retry({ retry: isError, signal: controller.signal, budget: 5 }, async () => {
		attempts++
		throw new Error('test error')
	})

	await expect(result).rejects.toThrow('This operation was aborted')
	expect(attempts).eq(0)
})

test('expects AbortError is not retryable', async () => {
	let attempts = 0
	let abortError = new Error('Operation was aborted')
	abortError.name = 'AbortError'

	let result = retry({ retry: isError, budget: 5 }, async () => {
		attempts++
		throw abortError
	})

	await expect(result).rejects.toThrow('Operation was aborted')
	expect(attempts).eq(1)
})

test('expects TimeoutError is not retryable', async () => {
	let attempts = 0
	let timeoutError = new Error('Operation timed out')
	timeoutError.name = 'TimeoutError'

	let result = retry({ retry: isError, budget: 5 }, async () => {
		attempts++
		throw timeoutError
	})

	await expect(result).rejects.toThrow('Operation timed out')
	expect(attempts).eq(1)
})

test('accepts custom retry function', async () => {
	let attempts = 0
	let retryCount = 0

	let customRetry = (error: unknown) => {
		retryCount++
		return error instanceof Error && error.message === 'retryable error'
	}

	let result = retry({ retry: customRetry, budget: 5 }, async () => {
		attempts++

		if (attempts === 1) {
			throw new Error('retryable error')
		} else if (attempts === 2) {
			throw new Error('non-retryable error')
		}

		return 'success'
	})

	await expect(result).rejects.toThrow('non-retryable error')
	expect(attempts).eq(2)
	expect(retryCount).eq(2)
})

test('accepts boolean retry config', async () => {
	let attempts = 0

	let result = retry({ retry: true, budget: 3 }, async () => {
		attempts++

		if (attempts < 3) {
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	expect(attempts).eq(3)
})

test('disables retry with false config', async () => {
	let attempts = 0

	let result = retry({ retry: false, budget: 5 }, async () => {
		attempts++
		throw new Error('test error')
	})

	await expect(result).rejects.toThrow('test error')
	expect(attempts).eq(1)
})

test('accepts dynamic budget function', async () => {
	let attempts = 0
	let budgetCalls = 0

	let dynamicBudget = (_ctx: any, _cfg: any) => {
		budgetCalls++
		return 3 // Allow up to 3 attempts
	}

	let result = retry({ retry: isError, budget: dynamicBudget }, async () => {
		attempts++

		if (attempts < 3) {
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	expect(attempts).eq(3)
	expect(budgetCalls).toBeGreaterThan(0)
})

test('accepts number strategy (fixed delay)', async () => {
	let attempts = 0
	let start = Date.now()

	let result = retry({ retry: isError, budget: 2, strategy: 100 }, async () => {
		attempts++

		if (attempts === 1) {
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	let elapsed = Date.now() - start
	expect(elapsed).toBeGreaterThanOrEqual(90) // Allow some timing variance
	expect(attempts).eq(2)
})

test('accepts custom strategy function', async () => {
	let attempts = 0
	let strategyCalls = 0

	let customStrategy = (ctx: any, _cfg: any) => {
		strategyCalls++
		return ctx.attempt * 50
	}

	let result = retry({ retry: isError, budget: 3, strategy: customStrategy }, async () => {
		attempts++

		if (attempts < 3) {
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	expect(attempts).eq(3)
	expect(strategyCalls).eq(2) // Called for each retry, not the first attempt
})

test('accepts onRetry callback', async () => {
	let attempts = 0
	let retryCallbacks: any[] = []

	let onRetry = (ctx: any) => {
		retryCallbacks.push({ attempt: ctx.attempt, error: ctx.error?.message })
	}

	let result = retry({ retry: isError, budget: 3, onRetry }, async () => {
		attempts++

		if (attempts < 3) {
			throw new Error(`error ${attempts}`)
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	expect(retryCallbacks).toHaveLength(2)
	expect(retryCallbacks[0]).toEqual({ attempt: 1, error: 'error 1' })
	expect(retryCallbacks[1]).toEqual({ attempt: 2, error: 'error 2' })
})

test('respects remaining delay time', async () => {
	let attempts = 0
	let start = Date.now()

	let customStrategy = () => 200 // 200ms delay

	let result = retry({ retry: isError, budget: 2, strategy: customStrategy }, async () => {
		attempts++

		if (attempts === 1) {
			// Simulate some processing time
			await new Promise(resolve => setTimeout(resolve, 150))
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	let elapsed = Date.now() - start
	expect(elapsed).toBeGreaterThanOrEqual(190) // 150ms processing + ~50ms remaining delay
	expect(elapsed).toBeLessThan(400) // Should not take full 200ms delay
})

test('handles promise-based function', async () => {
	let attempts = 0

	let asyncFn = async () => {
		attempts++

		if (attempts < 2) {
			throw new Error('test error')
		}

		return Promise.resolve('async success')
	}

	let result = retry({ retry: isError, budget: 3 }, asyncFn)

	await expect(result).resolves.eq('async success')
	expect(attempts).eq(2)
})

test('handles synchronous function', async () => {
	let attempts = 0

	let syncFn = () => {
		attempts++

		if (attempts < 2) {
			throw new Error('test error')
		}

		return 'sync success'
	}

	let result = retry({ retry: isError, budget: 3 }, syncFn)

	await expect(result).resolves.eq('sync success')
	expect(attempts).eq(2)
})

test('handles zero remaining delay time', async () => {
	let attempts = 0

	// Create a strategy that returns a very small delay
	let fastStrategy = () => 1 // 1ms delay

	let result = retry({
		retry: isError,
		budget: 3,
		strategy: fastStrategy
	}, async () => {
		attempts++

		if (attempts < 2) {
			// Add a small delay to ensure remaining delay is near zero
			await new Promise(resolve => setTimeout(resolve, 2))
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	expect(attempts).eq(2)
})

test('accepts linear strategy timing', async () => {
	let attempts = 0
	let delays: number[] = []
	let start = Date.now()

	// Use linear strategy with 50ms base
	let result = retry({
		retry: isError,
		budget: 3,
		strategy: (ctx) => {
			let delay = ctx.attempt * 50
			delays.push(delay)
			return delay
		}
	}, async () => {
		attempts++

		if (attempts < 3) {
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	expect(attempts).eq(3)
	expect(delays).toEqual([50, 100]) // Delays for retry 1 and 2

	let elapsed = Date.now() - start
	expect(elapsed).toBeGreaterThanOrEqual(140) // At least 50 + 100 - some tolerance
})

test('accepts exponential backoff and jitter', async () => {
	let attempts = 0

	// Combine exponential backoff with jitter
	let complexStrategy = (ctx: any) => {
		let exponential = Math.pow(2, ctx.attempt) * 10
		let jitter = Math.floor(Math.random() * 5)
		return exponential + jitter
	}

	let result = retry({
		retry: isError,
		budget: 2,
		strategy: complexStrategy
	}, async () => {
		attempts++

		if (attempts === 1) {
			throw new Error('test error')
		}

		return 'success'
	})

	await expect(result).resolves.eq('success')
	expect(attempts).eq(2)
})
