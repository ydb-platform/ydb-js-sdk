import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import { AuthServiceDefinition, LoginResponseSchema, LoginResultSchema } from '@ydbjs/api/auth'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Server } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import { StaticCredentialsProvider } from './static.ts'

// Controlled login responses avoid clock races around soft expiry and in-flight refreshes.
function loginResponse(expiresIn = 600) {
	let payload = Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + expiresIn })).toString(
		'base64url'
	)
	let token = `header.${payload}.signature`
	return create(LoginResponseSchema, {
		operation: {
			ready: true,
			status: StatusIds_StatusCode.SUCCESS,
			result: anyPack(LoginResultSchema, create(LoginResultSchema, { token })),
		},
	})
}

test('allocates a provider timeout only when starting a login', async (tc) => {
	using server = new Server()
	let logins = 0
	server.add(AuthServiceDefinition, {
		async login() {
			logins++
			return loginResponse()
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let provider = new StaticCredentialsProvider(
		{ username: 'test', password: 'test' },
		`grpc://127.0.0.1:${port}`
	)
	using timeout = vi.spyOn(AbortSignal, 'timeout')

	let token = await provider.getToken(false, tc.signal)
	expect(await provider.getToken()).toBe(token)
	expect(await provider.getToken()).toBe(token)
	expect(timeout.mock.calls).toEqual([[5000]])
	expect(logins).toBe(1)
})

test('allocates one default timeout when concurrent calls share a refresh', async (tc) => {
	using server = new Server()
	let started = Promise.withResolvers<void>()
	let release = Promise.withResolvers<void>()
	let logins = 0
	server.add(AuthServiceDefinition, {
		async login(_request, context) {
			logins++
			started.resolve()
			await abortable(context.signal, release.promise)
			return loginResponse()
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let provider = new StaticCredentialsProvider(
		{ username: 'test', password: 'test' },
		`grpc://127.0.0.1:${port}`
	)
	using timeout = vi.spyOn(AbortSignal, 'timeout')

	let tokens = Promise.all([provider.getToken(), provider.getToken(), provider.getToken()])
	void tokens.catch(() => {})
	await abortable(tc.signal, started.promise)
	expect(timeout.mock.calls).toEqual([[5000]])
	expect(logins).toBe(1)
	release.resolve()
	let [first, second, third] = await tokens
	expect(second).toBe(first)
	expect(third).toBe(first)
})

test('keeps a background refresh independent of the caller signal', async (tc) => {
	using server = new Server()
	let started = Promise.withResolvers<void>()
	let release = Promise.withResolvers<void>()
	let logins = 0
	server.add(AuthServiceDefinition, {
		async login(_request, context) {
			logins++
			if (logins === 2) {
				started.resolve()
				await abortable(context.signal, release.promise)
			}
			return loginResponse(logins === 1 ? 90 : 600)
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let provider = new StaticCredentialsProvider(
		{ username: 'test', password: 'test' },
		`grpc://127.0.0.1:${port}`
	)
	let token = await provider.getToken(false, tc.signal)
	using timeout = vi.spyOn(AbortSignal, 'timeout')

	let caller = new AbortController()
	expect(await provider.getToken(false, caller.signal)).toBe(token)
	caller.abort(new Error('Caller finished'))
	await abortable(tc.signal, started.promise)
	expect(await provider.getToken()).toBe(token)
	expect(await provider.getToken()).toBe(token)
	expect(timeout.mock.calls).toEqual([[30000]])
	expect(logins).toBe(2)
	let refreshed = provider.getToken(true, tc.signal)
	release.resolve()
	expect(await refreshed).not.toBe(token)
	expect(await provider.getToken()).not.toBe(token)
	expect(timeout.mock.calls).toEqual([[30000]])
})

test('cancels initiating and joining waits without cancelling the shared login', async (tc) => {
	using server = new Server()
	let started = Promise.withResolvers<AbortSignal>()
	let release = Promise.withResolvers<void>()
	let logins = 0
	server.add(AuthServiceDefinition, {
		async login(_request, context) {
			logins++
			started.resolve(context.signal)
			await abortable(context.signal, release.promise)
			return loginResponse()
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let provider = new StaticCredentialsProvider(
		{ username: 'test', password: 'test' },
		`grpc://127.0.0.1:${port}`
	)
	let initiating = new AbortController()
	let joining = new AbortController()
	let firstReason = new Error('Initiating caller cancelled')
	let secondReason = new Error('Joining caller cancelled')
	let first = provider.getToken(false, initiating.signal)
	let second = provider.getToken(false, joining.signal)
	let surviving = provider.getToken(false, tc.signal)
	void first.catch(() => {})
	void second.catch(() => {})
	let requestSignal = await abortable(tc.signal, started.promise)

	initiating.abort(firstReason)
	joining.abort(secondReason)
	await expect(first).rejects.toBe(firstReason)
	await expect(second).rejects.toBe(secondReason)
	expect(requestSignal.aborted).toBe(false)
	expect(logins).toBe(1)

	release.resolve()
	let token = await surviving
	expect(await provider.getToken(false, tc.signal)).toBe(token)
	expect(logins).toBe(1)
})

test('rejects an already cancelled token request without starting login', async () => {
	using server = new Server()
	let logins = 0
	server.add(AuthServiceDefinition, {
		async login() {
			logins++
			return loginResponse()
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let provider = new StaticCredentialsProvider(
		{ username: 'test', password: 'test' },
		`grpc://127.0.0.1:${port}`
	)
	using timeout = vi.spyOn(AbortSignal, 'timeout')
	let reason = new Error('Caller already cancelled')

	await expect(provider.getToken(false, AbortSignal.abort(reason))).rejects.toBe(reason)
	expect(logins).toBe(0)
	expect(timeout).not.toHaveBeenCalled()
})

test('bounds a shared login by its own timeout after all callers cancel', async (tc) => {
	using server = new Server()
	let started = Promise.withResolvers<AbortSignal>()
	let logins = 0
	server.add(AuthServiceDefinition, {
		async login(_request, context) {
			logins++
			started.resolve(context.signal)
			await abortable(context.signal, new Promise<void>(() => {}))
			return loginResponse()
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let provider = new StaticCredentialsProvider(
		{ username: 'test', password: 'test' },
		`grpc://127.0.0.1:${port}`
	)
	let caller = new AbortController()
	let reason = new Error('Caller cancelled')
	using timeout = vi.spyOn(AbortSignal, 'timeout')
	let cancelled = provider.getToken(false, caller.signal)
	void cancelled.catch(() => {})
	let requestSignal = await abortable(tc.signal, started.promise)
	caller.abort(reason)
	await expect(cancelled).rejects.toBe(reason)
	expect(requestSignal.aborted).toBe(false)

	let later = provider.getToken(false, tc.signal)
	await expect(later).rejects.toMatchObject({ name: 'TimeoutError' })
	await expect.poll(() => requestSignal.aborted).toBe(true)
	expect(logins).toBe(1)
	expect(timeout.mock.calls).toEqual([[5000]])
}, 10_000)
