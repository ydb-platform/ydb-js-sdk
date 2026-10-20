import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { CoordinationServiceDefinition, SessionResponseSchema } from '@ydbjs/api/coordination'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { CredentialsProvider } from '@ydbjs/auth'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import { CoordinationSession } from './session.ts'

test('close sends sessionStop and waits for the server acknowledgment', async (tc) => {
	using server = new Server()
	let stopReceived = Promise.withResolvers<void>()
	let allowStop = Promise.withResolvers<void>()
	server.add(CoordinationServiceDefinition, {
		async *session(requests, context) {
			for await (let request of requests) {
				if (request.request.case === 'sessionStart') {
					yield create(SessionResponseSchema, {
						response: { case: 'sessionStarted', value: { sessionId: 1n } },
					})
				} else if (request.request.case === 'sessionStop') {
					stopReceived.resolve()
					await abortable(context.signal, allowStop.promise)
					yield create(SessionResponseSchema, {
						response: { case: 'sessionStopped', value: { sessionId: 1n } },
					})
					return
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using session = new CoordinationSession(driver, { path: '/local/node' }, tc.signal)
	await session.waitReady(tc.signal)

	let finished = false
	let close = session.close(tc.signal).then(() => (finished = true))
	await abortable(tc.signal, stopReceived.promise)

	expect(finished).toBe(false)
	expect(session.status).toBe('closing')
	allowStop.resolve()
	await close
	expect(session.status).toBe('closed')
	await session.close(tc.signal)
})

test('destroy cancels the active RPC and rejects outstanding semaphore requests', async (tc) => {
	using server = new Server()
	let pending = Promise.withResolvers<AbortSignal>()
	let stopped = false
	server.add(CoordinationServiceDefinition, {
		async *session(requests, context) {
			for await (let request of requests) {
				if (request.request.case === 'sessionStart') {
					yield create(SessionResponseSchema, {
						response: { case: 'sessionStarted', value: { sessionId: 1n } },
					})
				} else if (request.request.case === 'createSemaphore') {
					pending.resolve(context.signal)
				} else if (request.request.case === 'sessionStop') {
					stopped = true
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using session = new CoordinationSession(driver, { path: '/local/node' }, tc.signal)
	await session.waitReady(tc.signal)
	let semaphore = session.semaphore('semaphore')
	let request = semaphore.create({ limit: 1 }, tc.signal)
	let reason = new Error('session destroyed')
	let failure = request.catch((error: unknown) => error)
	let serverSignal = await abortable(tc.signal, pending.promise)

	session.destroy(reason)

	expect(session.signal.aborted).toBe(true)
	expect(await failure).toBe(reason)
	await expect.poll(() => serverSignal.aborted).toBe(true)
	let laterRequest = semaphore.create({ limit: 1 }, tc.signal)
	await expect(laterRequest).rejects.toBe(reason)
	expect(stopped).toBe(false)
})

test('abort during token acquisition prevents opening the session RPC', async (tc) => {
	let controller = new AbortController()
	let reason = new Error('Stopped during token lookup')
	class Credentials extends CredentialsProvider {
		getToken(): Promise<string> {
			controller.abort(reason)
			return Promise.resolve('token')
		}
	}
	let received = 0
	using server = new Server()
	server.add(CoordinationServiceDefinition, {
		async *session(requests) {
			for await (let request of requests) {
				if (request.request.case === 'sessionStart') {
					received++
					yield create(SessionResponseSchema, {
						response: { case: 'sessionStarted', value: { sessionId: 1n } },
					})
				}
			}
		},
	})
	server.add(DiscoveryServiceDefinition, { whoAmI: () => ({}) })
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new Credentials(),
	})
	using session = new CoordinationSession(driver, { path: '/local/node' }, controller.signal)
	let discovery = driver.createClient(DiscoveryServiceDefinition)
	await discovery.whoAmI({}, { signal: tc.signal })

	expect(session.signal.aborted).toBe(true)
	expect(session.signal.reason).toBe(reason)
	expect(received).toBe(0)
})
