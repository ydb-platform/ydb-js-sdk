import { expect, test } from 'vitest'

import { retry } from './index.ts'

let isError = (error: unknown) => error instanceof Error

test('retries operation successfully', async () => {
	let attempts = 0

	let result = retry({ retry: isError, budget: Infinity }, async () => {
		if (attempts > 2) {
			return
		}

		attempts++
		throw new Error()
	})

	await expect(result).resolves.eq(void 0)
	expect(attempts).eq(3)
})

test('stops when budget exceeded', async () => {
	let attempts = 0

	let result = retry({ retry: isError, budget: 0 }, async () => {
		if (attempts > 2) {
			return
		}

		attempts++
		throw new Error()
	})

	await expect(result).rejects.toThrow('Retry budget exceeded')
	expect(attempts).eq(0)
})

test('retry with signal', async () => {
	let attempts = 0
	let controller = new AbortController()

	controller.abort()

	let result = retry({ retry: isError, signal: controller.signal }, async () => {
		if (attempts > 2) {
			return
		}

		attempts++
		throw new Error()
	})

	await expect(result).rejects.toThrow('This operation was aborted')
	expect(attempts).eq(0)
})
