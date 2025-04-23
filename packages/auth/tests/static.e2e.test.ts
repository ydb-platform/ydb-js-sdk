import { afterEach, describe, expect, inject, test, vi } from 'vitest'
import { createClientFactory } from 'nice-grpc'

import { StaticCredentialsProvider } from '../dist/esm/static.js'

let username = inject('credentialsUsername')
let password = inject('credentialsPassword')
let endpoint = inject('credentialsEndpoint')

describe('StaticCredentialsProvider', async () => {
	let calls = 0
	let clientFactory = createClientFactory().use((call, options) => {
		calls++
		return call.next(call.request, options)
	})

	afterEach(() => {
		calls = 0
	})

	test('valid token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint, clientFactory)

		let token = await provider.getToken(false)
		expect(token, 'Token is not empty').not.empty
	})

	test('reuse token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint, clientFactory)

		let token = await provider.getToken(false)
		let token2 = await provider.getToken(false)

		expect(token, 'Token is the same').eq(token2)
		expect(calls, 'Only one call was made').eq(1)
	})

	test('force refresh token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint, clientFactory)

		let token = await provider.getToken(false)
		let token2 = await provider.getToken(true)

		expect(token, 'Token is different').not.eq(token2)
		expect(calls, 'Two calls were made').eq(2)
	})

	test('auto refresh expired token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint, clientFactory)

		let token = await provider.getToken(false)
		vi.useFakeTimers({ now: new Date(2100, 0, 1) })
		let token2 = await provider.getToken(false)
		vi.useRealTimers()

		expect(token, 'Token is different').not.eq(token2)
		expect(calls, 'Two calls were made').eq(2)
	})

	test('multiple token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint, clientFactory)

		let tokens = await Promise.all([provider.getToken(false), provider.getToken(false), provider.getToken(false)])

		expect(new Set(tokens).size, 'All tokens are the same').eq(1)
		expect(calls, 'Only one call was made').eq(1)
	})

	test('abort token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint, clientFactory)

		let controller = new AbortController()
		controller.abort()
		let token = provider.getToken(false, controller.signal)

		await expect(() => token, 'Token aquisition was canceled').rejects.toThrow('This operation was aborted')
	})

	test('timeout token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint, clientFactory)

		let token = provider.getToken(false, AbortSignal.timeout(0))

		await expect(() => token, 'Token aquisition was canceled').rejects.toThrow('The operation has been aborted')
	})
})
