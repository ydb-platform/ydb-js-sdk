import * as assert from 'node:assert'
import test from 'node:test'

import { defaultRetryConfig } from '@ydbjs/retry'
import * as strategies from '@ydbjs/retry/strategy'

test('retry strategy', async (tc) => {
	await tc.test('fixed', async () => {
		let strategy = strategies.fixed(1000)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 1000)
	})

	await tc.test('linear', async () => {
		let strategy = strategies.linear(1000)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 0)

		delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 1000)

		delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 2000)

		delay = strategy({ attempt: 3, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 3000)
	})

	await tc.test('exponential', async () => {
		let strategy = strategies.exponential(1000)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 1000)

		delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 2000)

		delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 4000)
	})

	await tc.test('jitter', async () => {
		let strategy = strategies.jitter(10)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay <= 10)

		let delay2 = strategy({ attempt: 10, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay2 <= 20)

		let delay3 = strategy({ attempt: 20, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay3 <= 30)
	})

	await tc.test('random', async () => {
		let strategy = strategies.random(10, 20)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay >= 10 && delay <= 20)

		delay = strategy({ attempt: 10, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay >= 10 && delay <= 20)

		delay = strategy({ attempt: 20, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay >= 10 && delay <= 20)
	})

	await tc.test('backoff', async () => {
		let strategy = strategies.backoff(1000, 10000)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 1000)

		delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 2000)

		delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 4000)

		delay = strategy({ attempt: 10, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 10000)

		delay = strategy({ attempt: 20, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 10000)
	})

	await tc.test('combine', async () => {
		let strategy = strategies.combine(
			strategies.exponential(1000),
			strategies.jitter(10),
		)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay >= 1000 && delay <= 1030)

		delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay >= 2000 && delay <= 2030)

		delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
		assert.ok(delay >= 4000 && delay <= 4030)
	})

	await tc.test('compose', async () => {
		let strategy = strategies.compose(
			strategies.exponential(1000),
			strategies.jitter(10),
		)

		let delay = strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 1000)

		delay = strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 2000)

		delay = strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
		assert.strictEqual(delay, 4000)
	})
})
