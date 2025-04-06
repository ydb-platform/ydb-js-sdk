import { createClientFactory } from 'nice-grpc'
import * as assert from 'node:assert'
import { mock, test } from 'node:test'

import { StaticCredentialsProvider } from '../dist/esm/static.js'

await test('BasicCredentialsProvider', async (tc) => {
	let calls = 0

	let cs = new URL(process.env.YDB_CONNECTION_STRING!.replace(/^grpc/, 'http'))
	let cf = createClientFactory().use((call, options) => {
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

		let token = await provider.getToken(false, tc.signal)
		let token2 = await provider.getToken(true, tc.signal)

		assert.notStrictEqual(token, token2, 'Token is different')
		assert.strictEqual(calls, 2, 'Two calls were made')
	})

	await tc.test('auto refresh expired token', async (tc) => {
		if (parseInt(process.versions.node.split('.')[0], 10) < 20) {
			tc.skip('Date apis mocking is not supported in Node < 20')
			return
		}

		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let token = await provider.getToken(false, tc.signal)
		mock.timers.enable({ apis: ['Date'], now: new Date(2100, 0, 1) })
		let token2 = await provider.getToken(false, tc.signal)

		assert.notStrictEqual(token, token2, 'Token is different')
		assert.strictEqual(calls, 2, 'Two calls were made')
	})

	await tc.test('multiple token aquisition', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let tokens = await Promise.all([
			provider.getToken(false, tc.signal),
			provider.getToken(false, tc.signal),
			provider.getToken(false, tc.signal),
		])

		assert.ok(
			tokens.every((t) => t === tokens[0]),
			'All tokens are the same'
		)
		assert.strictEqual(calls, 1, 'Only one call was made')
	})

	await tc.test('abort token aquisition', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let controller = new AbortController()
		setTimeout(() => controller.abort(), 0)
		let token = provider.getToken(false, AbortSignal.any([controller.signal, tc.signal]))

		await assert.rejects(token, { name: 'AbortError' }, 'Token aquisition was canceled')
	})

	await tc.test('timeout token aquisition', async (tc) => {
		let provider = new StaticCredentialsProvider({ username: 'root', password: '1234' }, cs.origin, cf)

		let token = provider.getToken(false, AbortSignal.any([AbortSignal.timeout(0), tc.signal]))

		await assert.rejects(token, { name: 'AbortError' }, 'Token aquisition was timed out')
	})
})
