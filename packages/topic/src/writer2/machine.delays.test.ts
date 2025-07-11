import * as assert from 'node:assert'

import { afterAll, beforeAll, expect, test } from 'vitest'
import { WriterMachine } from './machine.ts'

let originalRandom = Math.random
beforeAll(() => Math.random = () => 0)
afterAll(() => Math.random = originalRandom)

test('retryDelay returns exponential backoff with jitter based on attempts', () => {
	let retryDelay = WriterMachine.implementations.delays.retryDelay!
	assert.ok(typeof retryDelay !== 'number')

	let context = { attempts: 0 }
	expect(retryDelay({ context } as any, {})).toBe(50)

	context = { attempts: 1 }
	expect(retryDelay({ context } as any, {})).toBe(100)

	context = { attempts: 2 }
	expect(retryDelay({ context } as any, {})).toBe(200)

	context = { attempts: 5 }
	expect(retryDelay({ context } as any, {})).toBe(1600)

	context = { attempts: 10 }
	expect(retryDelay({ context } as any, {})).toBe(5000) // capped at maxDelay
})

test('flushInterval returns flushIntervalMs from options', () => {
	let flushInterval = WriterMachine.implementations.delays.flushInterval!
	assert.ok(typeof flushInterval === 'function')

	let context = { options: { flushIntervalMs: 100500 } }
	expect(flushInterval({ context } as any, {})).toBe(100500)
})

test('gracefulShutdownTimeout returns gracefulShutdownTimeoutMs from options', () => {
	let gracefulShutdownTimeout = WriterMachine.implementations.delays.gracefulShutdownTimeout!
	assert.ok(typeof gracefulShutdownTimeout === 'function')

	let context = { options: { gracefulShutdownTimeoutMs: 100500 } }
	expect(gracefulShutdownTimeout({ context } as any, {})).toBe(100500)
})
