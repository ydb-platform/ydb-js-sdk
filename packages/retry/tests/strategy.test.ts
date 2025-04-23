import { expect, test } from 'vitest'

import { defaultRetryConfig } from '@ydbjs/retry'
import * as strategies from '@ydbjs/retry/strategy'

test('fixed', async () => {
	let strategy = strategies.fixed(1000)

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(1000)
})

test('linear', async () => {
	let strategy = strategies.linear(1000)

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(0)

	delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(1000)

	delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(2000)

	delay = strategy({ attempt: 3, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(3000)
})

test('exponential', async () => {
	let strategy = strategies.exponential(1000)

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(1000)

	delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(2000)

	delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(4000)
})

test('jitter', async () => {
	let strategy = strategies.jitter(10)

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay <= 10).eq(true)

	let delay2 = strategy({ attempt: 10, error: new Error('test') }, defaultRetryConfig)
	expect(delay2 <= 20).eq(true)

	let delay3 = strategy({ attempt: 20, error: new Error('test') }, defaultRetryConfig)
	expect(delay3 <= 30).eq(true)
})

test('random', async () => {
	let strategy = strategies.random(10, 20)

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay >= 10 && delay <= 20).eq(true)

	delay = strategy({ attempt: 10, error: new Error('test') }, defaultRetryConfig)
	expect(delay >= 10 && delay <= 20).eq(true)

	delay = strategy({ attempt: 20, error: new Error('test') }, defaultRetryConfig)
	expect(delay >= 10 && delay <= 20).eq(true)
})

test('backoff', async () => {
	let strategy = strategies.backoff(1000, 10000)

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(1000)

	delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(2000)

	delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(4000)

	delay = strategy({ attempt: 10, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(10000)

	delay = strategy({ attempt: 20, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(10000)
})

test('combine', async () => {
	let strategy = strategies.combine(strategies.exponential(1000), strategies.jitter(10))

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay >= 1000 && delay <= 1030).eq(true)

	delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
	expect(delay >= 2000 && delay <= 2030).eq(true)

	delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
	expect(delay >= 4000 && delay <= 4030).eq(true)
})

test('compose', async () => {
	let strategy = strategies.compose(strategies.exponential(1000), strategies.jitter(10))

	let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(1000)

	delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(2000)

	delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
	expect(delay).eq(4000)
})
