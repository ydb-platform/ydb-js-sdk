import { expect, test } from 'vitest'

import { safeHook } from './hooks.ts'

test('returns the hook result for a normal call', () => {
	expect(safeHook('x', (n: number) => n + 1, 41)).toBe(42)
})

test('returns undefined when the hook is not set', () => {
	expect(safeHook('x', undefined, 1)).toBeUndefined()
})

test('swallows a throwing hook and returns undefined', () => {
	let ran = false
	let result = safeHook('boom', () => {
		ran = true
		throw new Error('hook boom')
	})
	expect(ran).toBe(true)
	expect(result).toBeUndefined()
})
