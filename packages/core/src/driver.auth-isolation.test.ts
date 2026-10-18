import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import { AuthServiceDefinition, LoginResponseSchema, LoginResultSchema } from '@ydbjs/api/auth'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import { type CallOptions, Server, Status } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import { Driver } from './driver.ts'

// Gating Login makes cancellation during a shared refresh deterministic.
test.for([
	'initiator cancellation',
	'joiner cancellation',
	'RPC deadline',
	'token timeout',
	'driver close',
	'token getter close',
	'token getter timeout',
])('keeps a shared login alive after %s', async (interruption, tc) => {
	let loginStarted = Promise.withResolvers<void>()
	let allowLogin = Promise.withResolvers<void>()
	let loginSignal: AbortSignal | undefined
	let logins = 0
	let callers: string[] = []
	using server = new Server()
	server.add(AuthServiceDefinition, {
		async login(_request, context) {
			logins++
			loginSignal = context.signal
			loginStarted.resolve()
			await abortable(context.signal, allowLogin.promise)
			return create(LoginResponseSchema, {
				operation: {
					ready: true,
					status: StatusIds_StatusCode.SUCCESS,
					result: anyPack(
						LoginResultSchema,
						create(LoginResultSchema, { token: 'shared-token' })
					),
				},
			})
		},
	})
	server.add(DiscoveryServiceDefinition, {
		async whoAmI(_request, context) {
			expect(context.metadata['x-ydb-auth-ticket']).toBe('shared-token')
			callers.push(String(context.metadata['x-caller']))
			return {}
		},
	})
	let port = await server.listen()
	let provider = new StaticCredentialsProvider(
		{ username: 'test', password: 'test' },
		`grpc://127.0.0.1:${port}`
	)
	using getToken = vi.spyOn(provider, 'getToken')
	vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
	tc.onTestFinished(() => {
		allowLogin.resolve()
		vi.useRealTimers()
	})
	using firstDriver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		'ydb.sdk.token_timeout_ms': interruption.endsWith('timeout') ? 100 : 1000,
		credentialsProvider: provider,
	})
	using secondDriver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		'ydb.sdk.token_timeout_ms': 1000,
		credentialsProvider: provider,
	})
	let firstClient = firstDriver.createClient(DiscoveryServiceDefinition)
	let secondClient = secondDriver.createClient(DiscoveryServiceDefinition)
	let controller = new AbortController()
	let callerSignal = AbortSignal.any([tc.signal, controller.signal])
	let cancelJoiner = interruption === 'joiner cancellation'
	let firstOptions: CallOptions = {
		signal: cancelJoiner ? tc.signal : callerSignal,
		metadata: { 'x-caller': 'initiator' },
	}
	if (interruption === 'RPC deadline') firstOptions.deadline = Date.now() + 100
	let firstRequest = interruption.startsWith('token getter')
		? firstDriver.token
		: firstClient.whoAmI({}, firstOptions)
	let first = firstRequest.then(
		() => ({ ok: true }),
		(error: unknown) => ({ error })
	)
	await abortable(tc.signal, loginStarted.promise)
	let second = secondClient
		.whoAmI(
			{},
			{
				signal: cancelJoiner ? callerSignal : tc.signal,
				metadata: { 'x-caller': 'joiner' },
			}
		)
		.then(
			() => ({ ok: true }),
			(error: unknown) => ({ error })
		)
	expect(getToken).toHaveBeenCalledTimes(2)
	let interrupted = cancelJoiner ? second : first
	let survivor = cancelJoiner ? first : second
	let reason = new Error('caller cancelled authentication')
	let expectedError: { message?: string; code?: Status } = reason

	if (interruption.endsWith('cancellation')) {
		controller.abort(reason)
	} else if (interruption.endsWith('close')) {
		firstDriver.close()
		expectedError = { message: 'Driver is closed' }
	} else {
		await vi.advanceTimersByTimeAsync(100)
		expectedError = { code: Status.DEADLINE_EXCEEDED }
	}
	expect(await interrupted).toMatchObject({ error: expectedError })
	expect(loginSignal?.aborted).toBe(false)
	expect(callers).toEqual([])
	allowLogin.resolve()

	expect(await survivor).toEqual({ ok: true })
	expect(callers).toEqual([cancelJoiner ? 'initiator' : 'joiner'])
	await secondClient.whoAmI({}, { signal: tc.signal, metadata: { 'x-caller': 'cached' } })
	expect(callers).toEqual([cancelJoiner ? 'initiator' : 'joiner', 'cached'])
	expect(logins).toBe(1)
})
