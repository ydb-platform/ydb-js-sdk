import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { Client, credentials } from '@grpc/grpc-js'
import { abortable } from '@ydbjs/abortable'
import { AuthServiceDefinition, LoginResponseSchema, LoginResultSchema } from '@ydbjs/api/auth'
import { createServiceClient } from '@ydbjs/api/client'
import { DiscoveryServiceDefinition, WhoAmIResponseSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { createTestServer } from '../../../tests/grpc-server.ts'
import { expect, test } from 'vitest'

import { StaticCredentialsProvider } from './static.ts'

// A gated login response reproduces RPC completion during a soft-expiry refresh without clock races.
test.for([false, true])(
	'completed RPC leaves background refresh running (late cancel: %s)',
	async (lateCancel, tc) => {
		let refreshStarted = Promise.withResolvers<void>()
		let allowRefresh = Promise.withResolvers<void>()
		let tokens = [90, 600].map((expiresIn) => {
			let payload = Buffer.from(
				JSON.stringify({ exp: Date.now() / 1000 + expiresIn })
			).toString('base64url')
			return `header.${payload}.signature`
		})
		let logins = 0
		await using fixture = {
			server: createTestServer(),
			[Symbol.asyncDispose]() {
				allowRefresh.resolve()
				return this.server.shutdown()
			},
		}
		fixture.server.add(
			{ login: AuthServiceDefinition.login },
			{
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
			}
		)
		fixture.server.add(
			{ whoAmI: DiscoveryServiceDefinition.whoAmI },
			{
				async whoAmI(_request, context) {
					await abortable(context.signal, refreshStarted.promise)
					return create(WhoAmIResponseSchema, {})
				},
			}
		)
		let port = await fixture.server.listen('127.0.0.1:0')
		let provider = new StaticCredentialsProvider(
			{ username: 'test', password: 'test' },
			`grpc://127.0.0.1:${port}`
		)
		expect(await provider.getToken(true, tc.signal)).toBe(tokens[0])

		using rpc = {
			client: createServiceClient(
				DiscoveryServiceDefinition,
				new Client(`127.0.0.1:${port}`, credentials.createInsecure(), {
					interceptors: [provider.interceptor],
				})
			),
			[Symbol.dispose]() {
				this.client.close()
			},
		}
		let controller = new AbortController()
		let response = rpc.client.whoAmI(
			{},
			{ signal: AbortSignal.any([tc.signal, controller.signal]) }
		)
		await abortable(tc.signal, refreshStarted.promise)
		let refreshed = provider.getToken(true, tc.signal).then(
			(token) => ({ token }),
			(error: unknown) => ({ error })
		)

		await response
		if (lateCancel) {
			controller.abort()
		}
		allowRefresh.resolve()

		expect(await refreshed).toEqual({ token: tokens[1] })
		expect(await provider.getToken(false, tc.signal)).toBe(tokens[1])
		expect(logins).toBe(2)
	}
)
