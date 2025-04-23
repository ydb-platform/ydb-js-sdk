import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createClientFactory } from 'nice-grpc'

import { StaticCredentialsProvider } from '../dist/esm/static.js'

let username = process.env.YDB_CREDENTIALS_USER || 'root'
let password = process.env.YDB_CREDENTIALS_PASSWORD || ''

describe('StaticCredentialsProvider', async () => {
	let calls = 0
	let cs = new URL(process.env.YDB_CONNECTION_STRING!.replace(/^grpc/, 'http'))
	let cf = createClientFactory().use((call, options) => {
		calls++
		return call.next(call.request, options)
	})

	beforeEach(() => {
		// tell vitest we use mocked time
		vi.useFakeTimers()
	})

	afterEach(() => {
		calls = 0
		// restoring date after each test run
		vi.useRealTimers()
	})

	test('valid token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, cs.origin, cf)

		let token = await provider.getToken(false)
		expect(token, 'Token is not empty').not.empty
	})

	test('reuse token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, cs.origin, cf)

		let token = await provider.getToken(false)
		let token2 = await provider.getToken(false)

		expect(token, 'Token is the same').eq(token2)
		expect(calls, 'Only one call was made').eq(1)
	})

	test('force refresh token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, cs.origin, cf)

		let token = await provider.getToken(false)
		let token2 = await provider.getToken(true)

		expect(token, 'Token is different').not.eq(token2)
		expect(calls, 'Two calls were made').eq(2)
	})

	test('auto refresh expired token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, cs.origin, cf)

		let token = await provider.getToken(false)
		vi.setSystemTime(new Date(2100, 0, 1))
		let token2 = await provider.getToken(false)

		expect(token, 'Token is different').not.eq(token2)
		expect(calls, 'Two calls were made').eq(2)
	})

	test('multiple token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, cs.origin, cf)

		let tokens = await Promise.all([provider.getToken(false), provider.getToken(false), provider.getToken(false)])

		expect(new Set(tokens).size, 'All tokens are the same').eq(1)
		expect(calls, 'Only one call was made').eq(1)
	})

	test('abort token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, cs.origin, cf)

		let controller = new AbortController()
		controller.abort()
		let token = provider.getToken(false, controller.signal)

		await expect(() => token, 'Token aquisition was canceled').rejects.toThrow('This operation was aborted')
	})

	test('timeout token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, cs.origin, cf)

		let token = provider.getToken(false, AbortSignal.timeout(0))

		await expect(() => token, 'Token aquisition was canceled').rejects.toThrow('The operation has been aborted')
	})
})
