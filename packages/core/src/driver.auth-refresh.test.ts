import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import { AuthServiceDefinition, LoginResponseSchema, LoginResultSchema } from '@ydbjs/api/auth'
import { DiscoveryServiceDefinition, WhoAmIResponseSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { expect, test, vi } from 'vitest'

import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import { Server } from '@ydbjs/grpc'
import { Driver } from './driver.ts'

// A gated login response reproduces RPC completion during a soft-expiry refresh without clock races.
test.for(['completion', 'cancellation', 'driver close'])(
	'cached token refresh survives RPC %s and token timeout',
	async (completion, tc) => {
		let refreshStarted = Promise.withResolvers<void>()
		let allowRefresh = Promise.withResolvers<void>()
		let tokens = [90, 600].map((expiresIn) => {
			let payload = Buffer.from(
				JSON.stringify({ exp: Date.now() / 1000 + expiresIn })
			).toString('base64url')
			return `header.${payload}.signature`
		})
		let logins = 0
		using server = new Server()
		server.add(AuthServiceDefinition, {
			async login(_request, context) {
				let index = logins++
				if (index === 1) {
					refreshStarted.resolve()
					await abortable(context.signal, allowRefresh.promise)
				}
				return create(LoginResponseSchema, {
					operation: {
						ready: true,
						status: StatusIds_StatusCode.SUCCESS,
						result: anyPack(
							LoginResultSchema,
							create(LoginResultSchema, { token: tokens[index]! })
						),
					},
				})
			},
		})
		server.add(DiscoveryServiceDefinition, {
			async whoAmI(_request, context) {
				await abortable(context.signal, refreshStarted.promise)
				return create(WhoAmIResponseSchema, {})
			},
		})
		let port = await server.listen('127.0.0.1:0')
		let provider = new StaticCredentialsProvider(
			{ username: 'test', password: 'test' },
			`grpc://127.0.0.1:${port}`
		)
		expect(await provider.getToken(true, tc.signal)).toBe(tokens[0])
		vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
		tc.onTestFinished(() => {
			vi.useRealTimers()
		})

		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			'ydb.sdk.enable_discovery': false,
			'ydb.sdk.token_timeout_ms': 1000,
			credentialsProvider: provider,
		})
		let client = driver.createClient(DiscoveryServiceDefinition)
		let controller = new AbortController()
		let response = client.whoAmI(
			{},
			{ signal: AbortSignal.any([tc.signal, controller.signal]) }
		)
		await abortable(tc.signal, refreshStarted.promise)
		let refreshFinished = false
		let refreshed = provider.getToken(true, tc.signal).then(
			(token) => {
				refreshFinished = true
				return { token }
			},
			(error: unknown) => {
				refreshFinished = true
				return { error }
			}
		)

		await response
		await vi.advanceTimersByTimeAsync(1001)
		expect(refreshFinished).toBe(false)
		if (completion === 'cancellation') {
			controller.abort()
		} else if (completion === 'driver close') {
			driver.close()
		}
		allowRefresh.resolve()

		expect(await refreshed).toEqual({ token: tokens[1] })
		expect(await provider.getToken(false, tc.signal)).toBe(tokens[1])
		expect(logins).toBe(2)
	}
)
