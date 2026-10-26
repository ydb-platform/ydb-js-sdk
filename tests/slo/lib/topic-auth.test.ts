import { setImmediate } from 'node:timers/promises'

import { expect, test, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import {
	DiscoveryServiceDefinition,
	ListEndpointsResponseSchema,
	ListEndpointsResultSchema,
} from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	StreamReadMessage_FromServerSchema,
	StreamWriteMessage_FromClientSchema,
	StreamWriteMessage_FromServerSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { RpcError, Server, type ServiceClient, Status } from '@ydbjs/grpc'

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

// Controlled expiry and ACK order cannot be scheduled deterministically against live YDB.
test.for(['streamRead', 'streamWrite'] as const)(
	'observes token renewal through the native %s stream',
	async (method, tc) => {
		using now = vi.spyOn(Date, 'now').mockReturnValue(60_000)
		using server = new Server()
		server.add(TopicServiceDefinition, {
			async *streamRead(incoming) {
				let received = 0
				for await (let request of incoming) {
					expect(request.clientMessage.case).toBe('updateTokenRequest')
					yield create(StreamReadMessage_FromServerSchema, {
						status: StatusIds_StatusCode.SUCCESS,
						serverMessage: {
							case: ++received < 3 ? 'updateTokenResponse' : 'readResponse',
							value: {},
						},
					})
				}
			},
			async *streamWrite(incoming) {
				let received = 0
				for await (let request of incoming) {
					expect(request.clientMessage.case).toBe('updateTokenRequest')
					yield create(StreamWriteMessage_FromServerSchema, {
						status: StatusIds_StatusCode.SUCCESS,
						serverMessage: {
							case: ++received < 3 ? 'updateTokenResponse' : 'writeResponse',
							value: {},
						},
					})
				}
			},
		})
		let port = await server.listen()
		let auth = createTopicAuth(`grpc://127.0.0.1:${port}/Root`, true)
		using driver = auth.createDriver({
			'ydb.sdk.enable_discovery': false,
			credentialsProvider: new AnonymousCredentialsProvider(),
		})
		let firstAck = Promise.withResolvers<void>()
		let secondAck = Promise.withResolvers<void>()
		async function* requests() {
			yield {
				clientMessage: {
					case: 'updateTokenRequest' as const,
					value: { token: token(300) },
				},
			}
			await firstAck.promise
			yield {
				clientMessage: {
					case: 'updateTokenRequest' as const,
					value: { token: token(500) },
				},
			}
			await secondAck.promise
			yield {
				clientMessage: {
					case: 'updateTokenRequest' as const,
					value: { token: token(500) },
				},
			}
		}
		let client = driver.createClient(TopicServiceDefinition)
		let responses = 0
		let activeResult: ReturnType<typeof auth.finish>
		for await (let response of client[method](requests(), { signal: tc.signal })) {
			expect(response.status).toBe(StatusIds_StatusCode.SUCCESS)
			responses++
			if (responses === 1) {
				now.mockReturnValue(240_000)
				firstAck.resolve()
			} else if (responses === 2) {
				now.mockReturnValue(301_000)
				secondAck.resolve()
			} else {
				activeResult = auth.finish()
			}
		}
		expect(responses).toBe(3)
		expect(activeResult).toEqual({ streams: 1, renewed: 1, updates: 2, changes: 1 })
		expect(auth.finish()).toEqual({ streams: 1, renewed: 1, updates: 2, changes: 1 })
	}
)

test('verifies renewal when the server ignores an unchanged token', () => {
	let renewal = new TokenRenewal()
	renewal.sent(token(300), 60_000)
	renewal.acknowledge(token(500), 240_000)
	renewal.observe(301_000)
	expect(renewal.qualified()).toBe(true)
	expect(renewal.updates).toBe(1)
	expect(renewal.changes).toBe(1)
})

test('rejects an unsolicited token acknowledgment on the native stream', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead() {
			yield create(StreamReadMessage_FromServerSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				serverMessage: { case: 'updateTokenResponse', value: {} },
			})
		},
	})
	let port = await server.listen()
	let auth = createTopicAuth(`grpc://127.0.0.1:${port}/Root`, true)
	using driver = auth.createDriver({
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	async function* requests() {
		yield {}
	}
	let client = driver.createClient(TopicServiceDefinition)
	let iterator = client.streamRead(requests(), { signal: tc.signal })[Symbol.asyncIterator]()
	let response = iterator.next()

	await expect(response).rejects.toThrow('Token update acknowledged without a non-empty token')
	expect(() => auth.finish()).toThrow('No stream accepted a changed token')
})

test('preserves native transport failures while observing token renewal', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		streamRead() {
			throw new RpcError(Status.UNAVAILABLE, 'disconnected')
		},
	})
	let port = await server.listen()
	let auth = createTopicAuth(`grpc://127.0.0.1:${port}/Root`, true)
	using driver = auth.createDriver({
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	async function* requests() {
		yield {}
	}
	let client = driver.createClient(TopicServiceDefinition)
	let iterator = client.streamRead(requests(), { signal: tc.signal })[Symbol.asyncIterator]()
	let response = iterator.next()

	await expect(response).rejects.toMatchObject({
		code: Status.UNAVAILABLE,
		details: 'disconnected',
	})
	expect(() => auth.finish()).toThrow('No stream accepted a changed token')
})

test('leaves anonymous Topic streams unobserved', async (tc) => {
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead() {
			yield create(StreamReadMessage_FromServerSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				serverMessage: { case: 'readResponse', value: {} },
			})
		},
	})
	let port = await server.listen()
	let auth = createTopicAuth(`grpc://127.0.0.1:${port}/Root`, false)
	using driver = auth.createDriver({ 'ydb.sdk.enable_discovery': false })
	async function* requests() {
		yield {}
	}
	let client = driver.createClient(TopicServiceDefinition)
	let responses = []
	for await (let response of client.streamRead(requests(), { signal: tc.signal })) {
		responses.push(response)
	}
	expect(responses).toHaveLength(1)
	expect(auth.finish()).toBeUndefined()
})

test('does not count rejected token updates as renewal', async (tc) => {
	using now = vi.spyOn(Date, 'now').mockReturnValue(60_000)
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamRead(incoming) {
			for await (let request of incoming) {
				expect(request.clientMessage.case).toBe('updateTokenRequest')
				yield create(StreamReadMessage_FromServerSchema, {
					status: StatusIds_StatusCode.UNAUTHORIZED,
					serverMessage: { case: 'updateTokenResponse', value: {} },
				})
			}
			now.mockReturnValue(301_000)
			yield create(StreamReadMessage_FromServerSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				serverMessage: { case: 'readResponse', value: {} },
			})
		},
	})
	let port = await server.listen()
	let auth = createTopicAuth(`grpc://127.0.0.1:${port}/Root`, true)
	using driver = auth.createDriver({
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	async function* requests() {
		yield {
			clientMessage: { case: 'updateTokenRequest' as const, value: { token: token(300) } },
		}
		yield {
			clientMessage: { case: 'updateTokenRequest' as const, value: { token: token(500) } },
		}
	}
	let client = driver.createClient(TopicServiceDefinition)
	let responses = []
	for await (let response of client.streamRead(requests(), { signal: tc.signal })) {
		responses.push(response)
	}
	expect(responses).toHaveLength(3)
	expect(() => auth.finish()).toThrow('"updates":0,"changes":0')
})

// An undiscovered target proves pin routing instead of falling back to the bootstrap endpoint.
test('observes pinned writer streams independently and preserves client disposal', async (tc) => {
	using now = vi.spyOn(Date, 'now').mockReturnValue(60_000)
	using bootstrap = new Server()
	using direct = new Server()
	let bootstrapPort = 0
	let bootstrapCalls = 0
	let directCalls = 0
	bootstrap.add(DiscoveryServiceDefinition, {
		listEndpoints() {
			return create(ListEndpointsResponseSchema, {
				operation: {
					ready: true,
					status: StatusIds_StatusCode.SUCCESS,
					result: anyPack(
						ListEndpointsResultSchema,
						create(ListEndpointsResultSchema, {
							endpoints: [{ nodeId: 1, address: '127.0.0.1', port: bootstrapPort }],
						})
					),
				},
			})
		},
	})
	bootstrap.add(TopicServiceDefinition, {
		streamWrite() {
			bootstrapCalls++
			throw new RpcError(Status.INTERNAL, 'Unexpected bootstrap routing')
		},
	})
	direct.add(TopicServiceDefinition, {
		async *streamWrite(incoming) {
			directCalls++
			for await (let request of incoming) {
				yield create(StreamWriteMessage_FromServerSchema, {
					status: StatusIds_StatusCode.SUCCESS,
					serverMessage: {
						case:
							request.clientMessage.case === 'updateTokenRequest'
								? 'updateTokenResponse'
								: 'writeResponse',
						value: {},
					},
				})
			}
		},
	})
	bootstrapPort = await bootstrap.listen()
	let directPort = await direct.listen()
	let auth = createTopicAuth(`grpc://127.0.0.1:${bootstrapPort}/Root`, true)
	using driver = auth.createDriver({ credentialsProvider: new AnonymousCredentialsProvider() })
	await driver.ready(tc.signal)
	let target = { nodeId: 9n, hard: true, endpoint: { host: '127.0.0.1', port: directPort } }
	using first = await driver.createPinnedClient(TopicServiceDefinition, target, tc.signal)
	using second = await driver.createPinnedClient(TopicServiceDefinition, target, tc.signal)

	async function exchange(
		client: ServiceClient<typeof TopicServiceDefinition>,
		changed: boolean
	) {
		now.mockReturnValue(60_000)
		let firstAck = Promise.withResolvers<void>()
		let secondAck = Promise.withResolvers<void>()
		async function* requests() {
			yield create(StreamWriteMessage_FromClientSchema, {
				clientMessage: { case: 'updateTokenRequest', value: { token: token(300) } },
			})
			await abortable(tc.signal, firstAck.promise)
			yield create(StreamWriteMessage_FromClientSchema, {
				clientMessage: {
					case: 'updateTokenRequest',
					value: { token: token(changed ? 500 : 300) },
				},
			})
			await abortable(tc.signal, secondAck.promise)
			yield create(StreamWriteMessage_FromClientSchema, {
				clientMessage: { case: 'writeRequest', value: {} },
			})
		}
		let received = []
		for await (let response of client.streamWrite(requests(), { signal: tc.signal })) {
			received.push(response.serverMessage.case)
			if (received.length === 1) {
				now.mockReturnValue(240_000)
				firstAck.resolve()
			} else if (received.length === 2) {
				now.mockReturnValue(301_000)
				secondAck.resolve()
			}
		}
		return received
	}

	let firstResponses = await exchange(first, true)
	expect(firstResponses).toEqual(['updateTokenResponse', 'updateTokenResponse', 'writeResponse'])
	expect(auth.finish()).toEqual({ streams: 1, renewed: 1, updates: 2, changes: 1 })
	first.close()
	first[Symbol.dispose]()
	await setImmediate()

	let secondResponses = await exchange(second, false)
	expect(secondResponses).toEqual(firstResponses)
	expect(auth.finish()).toEqual({ streams: 2, renewed: 1, updates: 4, changes: 1 })
	expect(bootstrapCalls).toBe(0)
	expect(directCalls).toBe(2)
	second[Symbol.dispose]()
	await setImmediate()

	async function* emptyRequests() {
		yield create(StreamWriteMessage_FromClientSchema)
	}
	let closedStream = second
		.streamWrite(emptyRequests(), { signal: tc.signal })
		[Symbol.asyncIterator]()
	let closedResponse = closedStream.next()
	await expect(closedResponse).rejects.toThrow('Client is closed')

	let unpinned = driver.createClient(TopicServiceDefinition, { nodeId: 9n, hard: true })
	let unpinnedStream = unpinned
		.streamWrite(emptyRequests(), { signal: tc.signal })
		[Symbol.asyncIterator]()
	let unpinnedResponse = unpinnedStream.next()
	await expect(unpinnedResponse).rejects.toThrow(/No endpoint/)
	expect(directCalls).toBe(2)
})
