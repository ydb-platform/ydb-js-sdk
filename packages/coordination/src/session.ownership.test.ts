import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { CoordinationServiceDefinition, SessionResponseSchema } from '@ydbjs/api/coordination'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import { SessionRequestRegistry } from './runtime/session-registry.ts'
import { CoordinationSession } from './session.ts'

test.for([
	{ kind: 'semaphore', pending: false },
	{ kind: 'semaphore', pending: true },
	{ kind: 'mutex', pending: false },
	{ kind: 'mutex', pending: true },
	{ kind: 'election', pending: false },
	{ kind: 'election', pending: true },
])(
	'returns acknowledged $kind ownership after caller abort with pending=$pending',
	async ({ kind, pending }, tc) => {
		let caller = new AbortController()
		let reason = new Error('Caller cancelled after acknowledgment')
		let waiterRegistered = Promise.withResolvers<void>()
		let registrations = 0
		let register = SessionRequestRegistry.prototype.register
		using registered = vi
			.spyOn(SessionRequestRegistry.prototype, 'register')
			.mockImplementation(function (this: SessionRequestRegistry, reqId) {
				let request = register.call(this, reqId)
				if (++registrations === 2) waiterRegistered.resolve()
				return request
			})

		// A network peer cannot schedule cancellation between registry settlement and its promise continuation.
		let resolve = SessionRequestRegistry.prototype.resolve
		using resolved = vi
			.spyOn(SessionRequestRegistry.prototype, 'resolve')
			.mockImplementation(function (this: SessionRequestRegistry, reqId, response) {
				let accepted = resolve.call(this, reqId, response)
				if (response.response.case === 'acquireSemaphoreResult') caller.abort(reason)
				return accepted
			})
		let owned = false
		let releases = 0
		using server = new Server()
		server.add(CoordinationServiceDefinition, {
			async *session(requests, context) {
				for await (let request of requests) {
					switch (request.request.case) {
						case 'sessionStart':
							yield create(SessionResponseSchema, {
								response: { case: 'sessionStarted', value: { sessionId: 1n } },
							})
							break
						case 'acquireSemaphore': {
							let reqId = request.request.value.reqId
							if (pending) {
								yield create(SessionResponseSchema, {
									response: { case: 'acquireSemaphorePending', value: { reqId } },
								})
								await abortable(context.signal, waiterRegistered.promise)
							}
							owned = true
							yield create(SessionResponseSchema, {
								response: {
									case: 'acquireSemaphoreResult',
									value: {
										reqId,
										status: StatusIds_StatusCode.SUCCESS,
										acquired: true,
									},
								},
							})
							break
						}
						case 'releaseSemaphore':
							owned = false
							releases++
							yield create(SessionResponseSchema, {
								response: {
									case: 'releaseSemaphoreResult',
									value: {
										reqId: request.request.value.reqId,
										status: StatusIds_StatusCode.SUCCESS,
										released: true,
									},
								},
							})
							break
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
		let acquisition =
			kind === 'semaphore'
				? session.semaphore('resource').acquire({}, caller.signal)
				: kind === 'mutex'
					? session.mutex('resource').lock(caller.signal)
					: session.election('resource').campaign(new Uint8Array(), caller.signal)
		await using ownership = await acquisition

		expect(caller.signal.aborted).toBe(true)
		expect(session.status).toBe('ready')
		expect(ownership.signal.aborted).toBe(false)
		expect(owned).toBe(true)
		expect(releases).toBe(0)

		await ownership[Symbol.asyncDispose]()

		expect(owned).toBe(false)
		expect(releases).toBe(1)
		expect(registered).toHaveBeenCalledTimes(pending ? 3 : 2)
		expect(resolved).toHaveBeenCalledTimes(pending ? 3 : 2)
	}
)
