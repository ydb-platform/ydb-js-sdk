import { expect, test } from 'vitest'

import { runPaced } from './worker-api.ts'

test('preserves an independent final error when shutdown starts during the operation', async () => {
	let ctrl = new AbortController()
	let entered = Promise.withResolvers<void>()
	let operation = Promise.withResolvers<void>()
	let cause = new DOMException('operation deadline', 'TimeoutError')
	let run = runPaced(
		0,
		() => {
			entered.resolve()
			return operation.promise
		},
		ctrl.signal,
		1
	)
	await entered.promise
	ctrl.abort()
	operation.reject(cause)

	await expect(run).rejects.toBe(cause)
})

test('completes successfully for an operation aborted by the planned stop', async () => {
	let ctrl = new AbortController()
	let entered = Promise.withResolvers<void>()
	let operation = Promise.withResolvers<void>()
	let reason = new DOMException('planned stop', 'AbortError')
	let cancellation = new Error('operation aborted', { cause: reason })
	cancellation.name = 'AbortError'
	let run = runPaced(
		0,
		() => {
			entered.resolve()
			return operation.promise
		},
		ctrl.signal,
		1
	)
	await entered.promise
	ctrl.abort(reason)
	operation.reject(cancellation)

	await expect(run).resolves.toBeUndefined()
})
