import { mock, test } from 'node:test'
import * as assert from 'node:assert'
import { createClientFactory } from 'nice-grpc';

import { StaticCredentialsProvider } from "../dist/esm/static.js";

test('BasicCredentialsProvider', async (tc) => {
	let calls = 0

	let cs = new URL(process.env.YDB_CONNECTION_STRING!.replace(/^grpc/, 'http'))
	let cf = createClientFactory()
		.use((call, options) => {
			calls++
			return call.next(call.request, options)
		})

	tc.afterEach(() => {
		calls = 0
		mock.timers.reset()
	})

	await tc.test('valid token', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let token = await provider.getToken(false, tc.signal)
		assert.ok(token, 'Token is not empty')
	})

	await tc.test('reuse token', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let token = await provider.getToken(false, tc.signal)
		let token2 = await provider.getToken(false, tc.signal)

		assert.strictEqual(token, token2, 'Token is the same')
		assert.strictEqual(calls, 1, 'Only one call was made')
	})

	await tc.test('force refresh token', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let token = await provider.getToken()
		let token2 = await provider.getToken(true)

		assert.notStrictEqual(token, token2, 'Token is different')
		assert.strictEqual(calls, 2, 'Two calls were made')
	})

	await tc.test('auto refresh expired token', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let token = await provider.getToken()
		mock.timers.enable({ apis: ['Date'], now: new Date(2100, 0, 1) })
		let token2 = await provider.getToken()

		assert.notStrictEqual(token, token2, 'Token is different')
		assert.strictEqual(calls, 2, 'Two calls were made')
	})

	await tc.test('multiple token aquisition', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let tokens = await Promise.all([
			provider.getToken(),
			provider.getToken(),
			provider.getToken(),
		])

		assert.ok(tokens.every(t => t === tokens[0]), 'All tokens are the same')
		assert.strictEqual(calls, 1, 'Only one call was made')
	})

	await tc.test('abort token aquisition', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let controller = new AbortController()
		setTimeout(() => controller.abort(), 0)
		let token = provider.getToken(false, controller.signal)

		await assert.rejects(token, { name: 'AbortError' }, 'Token aquisition was canceled')
	})

	await tc.test('timeout token aquisition', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let token = provider.getToken(false, AbortSignal.timeout(0))

		await assert.rejects(token, { name: 'AbortError' }, 'Token aquisition was timed out')
	})
})
