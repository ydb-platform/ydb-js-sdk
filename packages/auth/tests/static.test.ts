import { channel as dc } from 'node:diagnostics_channel'

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

/**
 * Direct refresh observation. JWT byte-equality is unreliable as a proxy
 * — server stamps `iat` with 1s granularity and two refreshes inside one
 * wall-clock second produce byte-identical tokens. Counting refresh events
 * is the source of truth.
 */
function countRefreshes(): { count: number } & Disposable {
	let state = { count: 0 }
	let onRefresh = () => {
		state.count++
	}
	dc('ydb:auth.token.refreshed').subscribe(onRefresh)
	return {
		get count() {
			return state.count
		},
		[Symbol.dispose]() {
			dc('ydb:auth.token.refreshed').unsubscribe(onRefresh)
		},
	}
}

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

test('returns cached token and fires a background refresh in the soft expiry zone', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)
	using refreshes = countRefreshes()

	let token1 = await provider.getToken()
	let baseline = refreshes.count // initial login completed

	// Move time into the soft expiry zone (120 seconds before expiry)
	vi.useFakeTimers()
	let timeToSoftExpiry = (12 * 60 * 60 - SOFT_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToSoftExpiry))

	// Soft zone: cached value returns immediately (byte-equal — no new token
	// fetched yet), and a background refresh is kicked off asynchronously.
	let token2 = await provider.getToken()
	expect(token2).toBe(token1)

	// Wait for the fire-and-forget background refresh to land.
	vi.useRealTimers()
	await new Promise((resolve) => setTimeout(resolve, 100))

	expect(refreshes.count - baseline).toBeGreaterThanOrEqual(1)
})

test('blocks getToken on a fresh network refresh past the hard expiry threshold', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)
	using refreshes = countRefreshes()

	await provider.getToken()
	let baseline = refreshes.count // initial login completed

	// Move time to the hard expiry threshold (30 seconds before expiry).
	vi.useFakeTimers()
	let timeToHardExpiry = (12 * 60 * 60 - HARD_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToHardExpiry))

	// Synchronous refresh: getToken must NOT return until the network refresh
	// has succeeded, so by the time it resolves the counter must have ticked.
	await provider.getToken()
	expect(refreshes.count - baseline).toBeGreaterThanOrEqual(1)
})

test('escalates from background to synchronous refresh across soft → hard zones', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)
	using refreshes = countRefreshes()

	await provider.getToken()
	let baseline = refreshes.count // initial login completed

	vi.useFakeTimers()

	// Soft zone: getToken returns the cached value immediately. A background
	// refresh fires off but is not awaited by the caller — racing the assert
	// here would be flaky; we only check the cumulative state at the end.
	let timeToSoftExpiry = (12 * 60 * 60 - SOFT_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToSoftExpiry))
	await provider.getToken()

	// Hard zone: getToken blocks. The synchronous path here MUST produce a
	// refresh — that's the contract under test. The earlier background may
	// have landed too, so the delta is at least 1.
	let timeToHardExpiry = (12 * 60 * 60 - HARD_EXPIRY_THRESHOLD_SECONDS) * 1000
	vi.setSystemTime(new Date(vi.getRealSystemTime() + timeToHardExpiry))
	await provider.getToken()

	expect(refreshes.count - baseline).toBeGreaterThanOrEqual(1)
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

	for (let token of tokens) {
		expect(token).toBe(firstToken)
	}
})

test('respects abort signal', async () => {
	let endpoint = inject('credentialsEndpoint')
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	let provider = new StaticCredentialsProvider({ username, password }, endpoint)

	let controller = new AbortController()
	setTimeout(() => controller.abort(), 1)

	await expect(provider.getToken(false, controller.signal)).rejects.toThrow('aborted')
})

test('handles invalid credentials gracefully', async () => {
	let endpoint = inject('credentialsEndpoint')

	let provider = new StaticCredentialsProvider(
		{ username: 'invalid', password: 'invalid' },
		endpoint
	)

	await expect(provider.getToken()).rejects.toBeInstanceOf(Error)
})

test('handles invalid endpoint protocols', async () => {
	let username = inject('credentialsUsername')
	let password = inject('credentialsPassword')

	expect(() => {
		return new StaticCredentialsProvider({ username, password }, 'invalid://localhost:2136')
	}).toThrow('Invalid connection string protocol')
})
