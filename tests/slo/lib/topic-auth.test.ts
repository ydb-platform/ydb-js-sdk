import { expect, test, vi } from 'vitest'
import type { ClientMiddlewareCall } from 'nice-grpc'

import { getRegisteredClientMiddlewares } from '../../../packages/core/src/middleware.ts'

import { TokenRenewal, createTopicAuth } from './topic-auth.ts'

let token = (expiry: number) =>
	`header.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.signature`

test('requires a changed token and successful traffic after the old expiry on the same stream', () => {
	let renewal = new TokenRenewal()
	renewal.acknowledge(token(300), 60_000)
	renewal.acknowledge(token(500), 240_000)
	renewal.observe(299_000)
	expect(renewal.qualified()).toBe(false)

	renewal.observe(301_000)
	expect(renewal.qualified()).toBe(true)
	expect(renewal.changes).toBe(1)
})

test('does not count repeated acknowledgments of the same token as renewal', () => {
	let renewal = new TokenRenewal()
	renewal.acknowledge(token(300), 60_000)
	renewal.acknowledge(token(300), 120_000)
	renewal.observe(301_000)
	expect(renewal.qualified()).toBe(false)
	expect(renewal.updates).toBe(2)
})

test('does not combine token updates from different streams', () => {
	let first = new TokenRenewal()
	first.acknowledge(token(300), 60_000)
	first.observe(200_000)
	let replacement = new TokenRenewal()
	replacement.acknowledge(token(500), 240_000)
	replacement.observe(301_000)
	expect(first.qualified()).toBe(false)
	expect(replacement.qualified()).toBe(false)
})

test('rejects expired malformed and long-lived tokens', () => {
	for (let value of ['invalid', token(30), token(3600)]) {
		expect(() => new TokenRenewal().acknowledge(value, 60_000)).toThrow(
			'Token renewal requires'
		)
	}
})

test('observes token acknowledgments and data responses through the middleware', async () => {
	using now = vi.spyOn(Date, 'now').mockReturnValue(60_000)
	using auth = createTopicAuth('grpc://localhost:1/Root', true)
	let middleware = getRegisteredClientMiddlewares().at(-1)!
	async function* requests() {
		yield { clientMessage: { case: 'updateTokenRequest', value: { token: token(300) } } }
		now.mockReturnValue(240_000)
		yield { clientMessage: { case: 'updateTokenRequest', value: { token: token(500) } } }
	}
	let stream = middleware(
		{
			method: { path: '/Ydb.Topic.V1.TopicService/StreamRead' } as ClientMiddlewareCall<
				unknown,
				unknown
			>['method'],
			requestStream: true,
			responseStream: true,
			request: requests(),
			next: async function* (input) {
				for await (let request of input as AsyncIterable<unknown>) {
					expect(request).toBeDefined()
					yield { status: 400000, serverMessage: { case: 'updateTokenResponse' } }
				}
				now.mockReturnValue(301_000)
				yield { status: 400000, serverMessage: { case: 'readResponse' } }
			},
		},
		{}
	)
	for await (let response of stream) {
		expect(response).toBeDefined()
	}
	expect(auth.finish()).toEqual({ streams: 1, renewed: 1, updates: 2, changes: 1 })
})

test('verifies renewal when the server ignores an unchanged token', () => {
	let renewal = new TokenRenewal()
	renewal.sent(token(300), 60_000)
	renewal.acknowledge(token(500), 240_000)
	renewal.observe(301_000)
	expect(renewal.qualified()).toBe(true)
	expect(renewal.updates).toBe(1)
	expect(renewal.changes).toBe(1)
})
