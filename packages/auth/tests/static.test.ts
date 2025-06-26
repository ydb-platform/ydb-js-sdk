import { beforeEach, expect, inject, test, vi } from 'vitest'
import { StaticCredentialsProvider } from '../src/static.js'

/**
 * StaticCredentialsProvider Tests
 *
 * Tests for timing-based token refresh behavior:
 * - SOFT_EXPIRY_THRESHOLD_SECONDS = 120 (start background refresh)
 * - HARD_EXPIRY_THRESHOLD_SECONDS = 30 (force synchronous refresh)
 */

// Expiry thresholds from static.ts
const SOFT_EXPIRY_THRESHOLD_SECONDS = 120
const HARD_EXPIRY_THRESHOLD_SECONDS = 30

beforeEach(() => {
	vi.useRealTimers()
})

test('authenticates and returns valid token', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	let token = await provider.getToken()

	expect(token).toBeDefined()
	expect(typeof token).toBe('string')
	expect(token.length).toBeGreaterThan(0)
})

test('caches token and returns same value on subsequent calls', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	let token1 = await provider.getToken()
	let token2 = await provider.getToken()

	expect(token1).toBe(token2)
})

test('forces token refresh when force=true', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	let token1 = await provider.getToken()
	let token2 = await provider.getToken(true)

	expect(token1).toBeDefined()
	expect(token2).toBeDefined()
	expect(typeof token1).toBe('string')
	expect(typeof token2).toBe('string')
})

test('returns cached token when fresh (outside soft expiry threshold)', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	// Get initial token
	let token1 = await provider.getToken()
	expect(token1).toBeDefined()

	// Move time forward but keep token fresh
	vi.useFakeTimers()
	vi.setSystemTime(new Date(vi.getRealSystemTime() + 30 * 60 * 1000)) // 30 minutes

	let token2 = await provider.getToken()
	expect(token2).toBe(token1)
})

test('starts background refresh when approaching soft expiry threshold', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	// Get initial token
	let token1 = await provider.getToken()
	expect(token1).toBeDefined()

	// Move time to soft expiry threshold (120 seconds before expiry)
	vi.useFakeTimers()
	let timeToSoftExpiry = (12 * 60 * 60 - SOFT_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToSoftExpiry))

	// Should return cached token but start background refresh
	let token2 = await provider.getToken()
	expect(token2).toBeDefined()
	expect(token2).toBe(token1) // Still cached token

	vi.useRealTimers()
	await new Promise(resolve => setTimeout(resolve, 100))

	let token3 = await provider.getToken()
	expect(token3).toBeDefined()
	expect(token3).not.toBe(token1) // Background refresh should have updated the token
})

test('forces synchronous refresh when approaching hard expiry threshold', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	// Get initial token
	let token1 = await provider.getToken()
	expect(token1).toBeDefined()

	// Move time to hard expiry threshold (30 seconds before expiry)
	vi.useFakeTimers()
	let timeToHardExpiry = (12 * 60 * 60 - HARD_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToHardExpiry))

	// Should force synchronous refresh
	let token2 = await provider.getToken()
	expect(token2).toBeDefined()
	expect(token2).not.toBe(token1)
})

test('transitions from background to synchronous refresh', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	// Get initial token
	let token1 = await provider.getToken()
	expect(token1).toBeDefined()

	vi.useFakeTimers()

	// Move to soft expiry threshold (background refresh)
	let timeToSoftExpiry = (12 * 60 * 60 - SOFT_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToSoftExpiry))

	let token2 = await provider.getToken()
	expect(token2).toBeDefined()
	expect(token2).toBe(token1)

	// Move to hard expiry threshold (synchronous refresh)
	let timeToHardExpiry = (12 * 60 * 60 - HARD_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToHardExpiry))

	let token3 = await provider.getToken()
	expect(token3).toBeDefined()
	expect(token3).not.toBe(token1)
})

test('handles concurrent requests without duplicate authentication', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	// Concurrent requests from cold start should all get the same token
	let promises = Array.from({ length: 5 }, () => provider.getToken())
	let tokens = await Promise.all(promises)

	let firstToken = tokens[0]
	expect(firstToken).toBeDefined()

	tokens.forEach(token => {
		expect(token).toBe(firstToken)
	})
})

test('respects abort signal', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	let controller = new AbortController()
	setTimeout(() => controller.abort(), 1)

	await expect(provider.getToken(false, controller.signal)).rejects.toThrow()
})

test('handles invalid credentials gracefully', async () => {
	let endpoint = inject('credentialsEndpoint')

	let provider = new StaticCredentialsProvider({ username: 'invalid', password: 'invalid' }, endpoint)

	await expect(provider.getToken()).rejects.toThrow()
})

test('handles invalid endpoint protocols', async () => {
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	expect(() => {
		return new StaticCredentialsProvider({ username, password }, 'invalid://localhost:2136')
	}).toThrow('Invalid connection string protocol')
})
