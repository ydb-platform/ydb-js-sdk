import { expect, test } from 'vitest'

import { defaultRetryConfig } from './index.ts'
import * as strategies from './strategy.ts'

test('applies fixed delay strategy', async () => {
	let strategy = strategies.fixed(1000)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(1000)
})

test('applies linear backoff strategy', async () => {
	let strategy = strategies.linear(1000)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)

	delay = strategy(
		{ attempt: 1, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(1000)

	delay = strategy(
		{ attempt: 2, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(2000)

	delay = strategy(
		{ attempt: 3, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(3000)
})

test('applies exponential backoff strategy', async () => {
	let strategy = strategies.exponential(1000)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(1000)

	delay = strategy(
		{ attempt: 1, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(2000)

	delay = strategy(
		{ attempt: 2, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(4000)
})

test('applies jitter to delay strategy', async () => {
	let strategy = strategies.jitter(10)

	// For attempt 0: random(0-9) + 0 = 0-9
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay >= 0 && delay <= 9).eq(true)

	// For attempt 10: random(0-9) + 10 = 10-19
	let delay2 = strategy(
		{ attempt: 10, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay2 >= 10 && delay2 <= 19).eq(true)

	// For attempt 20: random(0-9) + 20 = 20-29
	let delay3 = strategy(
		{ attempt: 20, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay3 >= 20 && delay3 <= 29).eq(true)
})

test('applies random delay strategy', async () => {
	let strategy = strategies.random(10, 20)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay >= 10 && delay <= 20).eq(true)

	delay = strategy(
		{ attempt: 10, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay >= 10 && delay <= 20).eq(true)

	delay = strategy(
		{ attempt: 20, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay >= 10 && delay <= 20).eq(true)
})

test('applies backoff delay strategy', async () => {
	let strategy = strategies.backoff(1000, 10000)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(1000)

	delay = strategy(
		{ attempt: 1, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(2000)

	delay = strategy(
		{ attempt: 2, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(4000)

	delay = strategy(
		{ attempt: 10, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(10000)

	delay = strategy(
		{ attempt: 20, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(10000)
})

test('combines multiple strategies', async () => {
	let strategy = strategies.combine(
		strategies.exponential(1000),
		strategies.jitter(10)
	)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay >= 1000 && delay <= 1030).eq(true)

	delay = strategy(
		{ attempt: 1, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay >= 2000 && delay <= 2030).eq(true)

	delay = strategy(
		{ attempt: 2, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay >= 4000 && delay <= 4030).eq(true)
})

test('composes strategy functions', async () => {
	// compose returns the maximum value from all strategies
	let strategy = strategies.compose(
		strategies.exponential(1000),
		strategies.jitter(10)
	)

	// exponential(1000) with attempt 0 = 1000, jitter(10) with attempt 0 = 0-9
	// max(1000, 0-9) = 1000
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(1000)

	// exponential(1000) with attempt 1 = 2000, jitter(10) with attempt 1 = 1-10
	// max(2000, 1-10) = 2000
	delay = strategy(
		{ attempt: 1, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(2000)

	// exponential(1000) with attempt 2 = 4000, jitter(10) with attempt 2 = 2-11
	// max(4000, 2-11) = 4000
	delay = strategy(
		{ attempt: 2, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(4000)
})

test('applies fixed strategy with zero delay', async () => {
	let strategy = strategies.fixed(0)
	let delay = strategy(
		{ attempt: 5, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)
})

test('applies linear strategy with zero base', async () => {
	let strategy = strategies.linear(0)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)

	delay = strategy(
		{ attempt: 5, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)
})

test('applies exponential strategy with zero base', async () => {
	let strategy = strategies.exponential(0)

	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)

	delay = strategy(
		{ attempt: 5, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)
})

test('handles random strategy edge cases', async () => {
	// Same min and max should always return the same value
	let strategy = strategies.random(100, 100)
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(100)

	// Min greater than max should still work (Math.random behavior)
	let strategy2 = strategies.random(100, 50)
	let delay2 = strategy2(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(typeof delay2).eq('number')
})

test('applies jitter strategy with zero jitter', async () => {
	let strategy = strategies.jitter(0)

	// With 0 jitter, should return exactly the attempt number
	let delay = strategy(
		{ attempt: 5, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(5)
})

test('handles backoff strategy edge cases', async () => {
	// Base larger than max should be capped at max
	let strategy = strategies.backoff(5000, 1000)
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(1000)

	// Zero max should always return 0
	let strategy2 = strategies.backoff(1000, 0)
	let delay2 = strategy2(
		{ attempt: 1, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay2).eq(0)
})

test('combines empty strategies', async () => {
	let strategy = strategies.combine()
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)
})

test('composes empty strategies', async () => {
	let strategy = strategies.compose()
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(0)
})

test('combines single strategy', async () => {
	let strategy = strategies.combine(strategies.fixed(500))
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(500)
})

test('composes single strategy', async () => {
	let strategy = strategies.compose(strategies.fixed(500))
	let delay = strategy(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)
	expect(delay).eq(500)
})

test('handles large attempt numbers correctly', async () => {
	let largeAttempt = 1000

	// Test that strategies don't break with large numbers
	let fixedStrategy = strategies.fixed(100)
	expect(
		fixedStrategy(
			{ attempt: largeAttempt, error: new Error('test') },
			defaultRetryConfig
		)
	).eq(100)

	let linearStrategy = strategies.linear(10)
	expect(
		linearStrategy(
			{ attempt: largeAttempt, error: new Error('test') },
			defaultRetryConfig
		)
	).eq(10000)

	// Exponential should handle large numbers without throwing
	let exponentialStrategy = strategies.exponential(1)
	let expResult = exponentialStrategy(
		{ attempt: largeAttempt, error: new Error('test') },
		defaultRetryConfig
	)
	expect(typeof expResult).eq('number')
	expect(expResult).toBeGreaterThan(0)
})

test('respects backoff strategy max limit properly', async () => {
	let strategy = strategies.backoff(100, 500)

	// Should grow exponentially until max
	expect(
		strategy({ attempt: 0, error: new Error('test') }, defaultRetryConfig)
	).eq(100) // 2^0 * 100 = 100
	expect(
		strategy({ attempt: 1, error: new Error('test') }, defaultRetryConfig)
	).eq(200) // 2^1 * 100 = 200
	expect(
		strategy({ attempt: 2, error: new Error('test') }, defaultRetryConfig)
	).eq(400) // 2^2 * 100 = 400
	expect(
		strategy({ attempt: 3, error: new Error('test') }, defaultRetryConfig)
	).eq(500) // 2^3 * 100 = 800, capped at 500
	expect(
		strategy({ attempt: 10, error: new Error('test') }, defaultRetryConfig)
	).eq(500) // Still capped at 500
})

test('handles negative delays in combine strategy', async () => {
	// Create a strategy that returns negative values
	let negativeStrategy = () => -100
	let positiveStrategy = strategies.fixed(200)

	let combined = strategies.combine(negativeStrategy, positiveStrategy)
	let result = combined(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)

	expect(result).eq(100) // -100 + 200 = 100
})

test('handles mixed positive and negative in compose strategy', async () => {
	// Create strategies with different return values
	let strategy1 = () => -50
	let strategy2 = () => 100
	let strategy3 = () => 25

	let composed = strategies.compose(strategy1, strategy2, strategy3)
	let result = composed(
		{ attempt: 0, error: new Error('test') },
		defaultRetryConfig
	)

	expect(result).eq(100) // max(-50, 100, 25) = 100
})
