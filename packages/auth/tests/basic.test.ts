import { mock, test } from 'node:test'
import * as assert from 'node:assert'

import { createGrpcTransport } from '@connectrpc/connect-node';

import { BasicCredentialsProvider } from "../dist/esm/basic.js";
import { Code } from '@connectrpc/connect';

test('BasicCredentialsProvider', async (tc) => {
	let calls = 0

	let url = new URL(process.env.YDB_CONNECTION_STRING!)
	let baseUrl = url.protocol.includes('s:') ? 'https://' : 'http://' + url.host

	let transport = createGrpcTransport({
		baseUrl,
		interceptors: [
			function (next) {
				return async function (request) {
					calls += 1

					return next(request)
				}
			}
		]
	});

	tc.afterEach(() => {
		calls = 0
		mock.timers.reset()
	})

	await tc.test('valid token', async (tc) => {
		let provider = new BasicCredentialsProvider(transport, { username: 'root', password: '1234' })

		let token = await provider.getToken(false, tc.signal)
		assert.ok(token, 'Token is not empty')
	})

	await tc.test('reuse token', async (tc) => {
		let provider = new BasicCredentialsProvider(transport, { username: 'root', password: '1234' })

		let token = await provider.getToken(false, tc.signal)
		let token2 = await provider.getToken(false, tc.signal)

		assert.strictEqual(token, token2, 'Token is the same')
		assert.strictEqual(calls, 1, 'Only one call was made')
	})

	await tc.test('force refresh token', async (tc) => {
		let provider = new BasicCredentialsProvider(transport, { username: 'root', password: '1234' })

		let token = await provider.getToken()
		let token2 = await provider.getToken(true)

		assert.notStrictEqual(token, token2, 'Token is different')
		assert.strictEqual(calls, 2, 'Two calls were made')
	})

	await tc.test('refresh expired token', async (tc) => {
		let provider = new BasicCredentialsProvider(transport, { username: 'root', password: '1234' })

		let token = await provider.getToken()
		mock.timers.enable({ apis: ['Date'], now: Number.MAX_SAFE_INTEGER })
		let token2 = await provider.getToken()

		assert.notStrictEqual(token, token2, 'Token is different')
		assert.strictEqual(calls, 2, 'Two calls were made')
	})

	await tc.test('multiple token aquisition', async (tc) => {
		let provider = new BasicCredentialsProvider(transport, { username: 'root', password: '1234' })

		let tokens = await Promise.all([
			provider.getToken(),
			provider.getToken(),
			provider.getToken(),
		])

		assert.ok(tokens.every(t => t === tokens[0]), 'All tokens are the same')
		assert.strictEqual(calls, 1, 'Only one call was made')
	})

	await tc.test('abort token aquisition', async (tc) => {
		let provider = new BasicCredentialsProvider(transport, { username: 'root', password: '1234' })

		let controller = new AbortController()
		setTimeout(() => controller.abort(), 0)
		let token = provider.getToken(false, controller.signal)

		await assert.rejects(token, { name: 'ConnectError', code: Code.Canceled }, 'Token aquisition was canceled')
	})

	await tc.test('timeout token aquisition', async (tc) => {
		let provider = new BasicCredentialsProvider(transport, { username: 'root', password: '1234' })

		let token = provider.getToken(false, AbortSignal.timeout(0))

		await assert.rejects(token, { name: 'ConnectError', code: Code.DeadlineExceeded }, 'Token aquisition was timed out')
	})
})
