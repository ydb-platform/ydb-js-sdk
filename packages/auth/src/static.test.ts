import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { AuthServiceDefinition, LoginResponseSchema, LoginResultSchema } from '@ydbjs/api/auth'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { type ServiceImplementation, createServer } from 'nice-grpc'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

import { StaticCredentialsProvider } from './static.js'

let AuthServiceTestImpl: ServiceImplementation<typeof AuthServiceDefinition> = {
	login: async () => {
		return create(LoginResponseSchema, {
			operation: {
				status: StatusIds_StatusCode.SUCCESS,
				result: anyPack(LoginResultSchema, create(LoginResultSchema, {
					token: crypto.randomUUID()
				})),
			}
		})
	}
}

describe('StaticCredentialsProvider', async () => {
	let calls = 0

	let server = createServer().use((call, options) => {
		calls++
		return call.next(call.request, options)
	})

	server.add(AuthServiceDefinition, AuthServiceTestImpl)

	afterEach(() => {
		calls = 0
	})

	afterAll(async () => {
		await server.shutdown()
		await fs.rm(socket, { force: true });
	})

	let socket = path.join(os.tmpdir(), `test-grpc-server-${Date.now()}.sock`);
	let endpoint = `unix:${socket}`
	let username = 'test'
	let password = '1234'

	await server.listen(endpoint)

	test('valid token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint)

		let token = await provider.getToken(false)
		expect(token, 'Token is not empty').not.empty
	})

	test('reuse token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint)

		let token = await provider.getToken(false)
		let token2 = await provider.getToken(false)

		expect(token, 'Token is the same').eq(token2)
		expect(calls, 'Only one call was made').eq(1)
	})

	test('force refresh token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint)

		let token = await provider.getToken(false)
		let token2 = await provider.getToken(true)

		expect(token, 'Token is different').not.eq(token2)
		expect(calls, 'Two calls were made').eq(2)
	})

	test('auto refresh expired token', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint)

		let token = await provider.getToken(false)
		vi.useFakeTimers({ now: new Date(2100, 0, 1) })
		let token2 = await provider.getToken(false)
		vi.useRealTimers()

		expect(token, 'Token is different').not.eq(token2)
		expect(calls, 'Two calls were made').eq(2)
	})

	test('multiple token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint)

		let tokens = await Promise.all([provider.getToken(false), provider.getToken(false), provider.getToken(false)])

		expect(new Set(tokens).size, 'All tokens are the same').eq(1)
		expect(calls, 'Only one call was made').eq(1)
	})

	test('abort token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint)

		let controller = new AbortController()
		controller.abort()
		let token = provider.getToken(false, controller.signal)

		await expect(() => token, 'Token aquisition was canceled').rejects.toThrow('This operation was aborted')
	})

	test('timeout token aquisition', async () => {
		let provider = new StaticCredentialsProvider({ username, password }, endpoint)

		let token = provider.getToken(false, AbortSignal.timeout(0))

		await expect(() => token, 'Token aquisition was canceled').rejects.toThrow('The operation has been aborted')
	})
})
