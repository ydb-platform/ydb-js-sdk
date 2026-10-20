import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import { DiscoveryServiceDefinition, ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { CredentialsProvider } from '@ydbjs/auth'
import { Server, Status } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import { Driver } from './driver.js'

let messagesService = {
	messages: {
		path: '/test.Messages/Read',
		requestStream: false as const,
		responseStream: true as const,
		requestSerialize: (_request: Record<string, never>) => Buffer.alloc(0),
		requestDeserialize: () => ({}),
		responseSerialize: (message: string) => Buffer.from(message),
		responseDeserialize: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
	},
}

async function listenWithDiscovery(server: Server): Promise<string> {
	let port = 0
	server.add(DiscoveryServiceDefinition, {
		listEndpoints() {
			let result = create(ListEndpointsResultSchema, {
				endpoints: [{ nodeId: 1, address: '127.0.0.1', port }],
			})
			return {
				operation: {
					ready: true,
					status: StatusIds_StatusCode.SUCCESS,
					result: anyPack(ListEndpointsResultSchema, result),
				},
			}
		},
	})
	port = await server.listen()
	return `grpc://127.0.0.1:${port}/local`
}

// Controlled responses expose shutdown races that real YDB cannot hold deterministically.
test.for([false, true])(
	'using cancels an active unary call without waiting for its response (discovery: %s)',
	async (discovery, tc) => {
		let entered = Promise.withResolvers<void>()
		let cancelled = Promise.withResolvers<void>()
		let response = Promise.withResolvers<{}>()
		using server = new Server()
		server.add(DiscoveryServiceDefinition, {
			whoAmI(_request, context) {
				context.signal.addEventListener('abort', () => cancelled.resolve(), {
					once: true,
				})
				entered.resolve()
				return abortable(context.signal, response.promise)
			},
		})
		let connectionString = await listenWithDiscovery(server)
		let pending: Promise<unknown>
		{
			using driver = new Driver(connectionString, { 'ydb.sdk.enable_discovery': discovery })
			await driver.ready(tc.signal)
			let client = driver.createClient(DiscoveryServiceDefinition)
			pending = client.whoAmI({}, { signal: tc.signal })
			await abortable(tc.signal, entered.promise)
		}

		await expect(pending).rejects.toThrow('Driver is closed')
		await abortable(tc.signal, cancelled.promise)
	}
)

test.for([false, true])(
	'using cancels an open response stream (discovery: %s)',
	async (discovery, tc) => {
		let nextMessage = Promise.withResolvers<void>()
		let cancelled = Promise.withResolvers<void>()
		using server = new Server()
		server.add(messagesService, {
			async *messages(_request, context) {
				context.signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
				yield 'first'
				await abortable(context.signal, nextMessage.promise)
				yield 'second'
			},
		})
		let connectionString = await listenWithDiscovery(server)
		let pending: Promise<IteratorResult<string>>
		{
			using driver = new Driver(connectionString, { 'ydb.sdk.enable_discovery': discovery })
			await driver.ready(tc.signal)
			let client = driver.createClient(messagesService)
			let responses = client.messages({}, { signal: tc.signal })[Symbol.asyncIterator]()
			expect(await responses.next()).toEqual({ value: 'first', done: false })
			pending = responses.next()
		}

		await expect(pending).rejects.toThrow('Driver is closed')
		await abortable(tc.signal, cancelled.promise)
	}
)

test.for([false, true])(
	'close discards buffered responses even after an OK status (discovery: %s)',
	async (discovery, tc) => {
		using server = new Server()
		server.add(messagesService, {
			async *messages() {
				yield 'first'
				yield 'second'
				yield 'third'
			},
		})
		let connectionString = await listenWithDiscovery(server)
		using driver = new Driver(connectionString, { 'ydb.sdk.enable_discovery': discovery })
		await driver.ready(tc.signal)
		let client = driver.createClient(messagesService)
		let terminal = Promise.withResolvers<number>()
		let stream = client.messages(
			{},
			{
				signal: tc.signal,
				onStatus: (status) => terminal.resolve(status.code),
			}
		)
		let responses = stream[Symbol.asyncIterator]()
		expect(await responses.next()).toEqual({ value: 'first', done: false })
		expect(await abortable(tc.signal, terminal.promise)).toBe(0)

		driver.close()

		let next = responses.next()
		await expect(next).rejects.toThrow('Driver is closed')
	}
)

test.for([false, true])(
	'close is synchronous and idempotent and rejects subsequent calls (discovery: %s)',
	async (discovery, tc) => {
		using server = new Server()
		let calls = 0
		server.add(DiscoveryServiceDefinition, {
			whoAmI() {
				calls++
				return {}
			},
		})
		let connectionString = await listenWithDiscovery(server)
		using driver = new Driver(connectionString, { 'ydb.sdk.enable_discovery': discovery })
		await driver.ready(tc.signal)
		let client = driver.createClient(DiscoveryServiceDefinition)
		await client.whoAmI({}, { signal: tc.signal })

		expect(driver.close()).toBeUndefined()
		expect(driver.close()).toBeUndefined()
		expect(Symbol.asyncDispose in driver).toBe(false)

		let request = client.whoAmI({}, { signal: tc.signal })
		await expect(request).rejects.toThrow(/closed/i)
		await expect(driver.ready(tc.signal)).rejects.toThrow('Driver is closed')
		expect(calls).toBe(1)
	}
)

test.for([false, true])(
	'close cancels pending token waits before opening an RPC (discovery: %s)',
	async (discovery, tc) => {
		let entered = Promise.withResolvers<void>()
		let token = Promise.withResolvers<string>()
		let pendingAuth = false
		let providerSignal: AbortSignal | undefined
		class PendingCredentials extends CredentialsProvider {
			getToken(_force?: boolean, signal?: AbortSignal): Promise<string> {
				if (!pendingAuth) return Promise.resolve('initial-token')
				providerSignal = signal
				entered.resolve()
				return token.promise
			}
		}
		using server = new Server()
		let calls = 0
		server.add(DiscoveryServiceDefinition, {
			whoAmI() {
				calls++
				return {}
			},
		})
		let connectionString = await listenWithDiscovery(server)
		using driver = new Driver(connectionString, {
			'ydb.sdk.enable_discovery': discovery,
			credentialsProvider: new PendingCredentials(),
		})
		await driver.ready(tc.signal)
		pendingAuth = true
		let client = driver.createClient(DiscoveryServiceDefinition)
		let request = client.whoAmI({}, { signal: tc.signal })
		await abortable(tc.signal, entered.promise)

		driver.close()

		expect(providerSignal).toBeUndefined()
		await expect(request).rejects.toThrow('Driver is closed')
		token.resolve('late-token')
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(calls).toBe(0)
	}
)

test('rejects token reads after close without requesting credentials', async () => {
	let requests = 0
	class TestCredentials extends CredentialsProvider {
		async getToken(): Promise<string> {
			requests++
			return 'unused-token'
		}
	}
	using driver = new Driver('grpc://127.0.0.1:1/local', {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new TestCredentials(),
	})
	driver.close()
	let token = driver.token

	await expect(token).rejects.toThrow('Driver is closed')
	expect(requests).toBe(0)
})

test.for([false, true])(
	'closing one service client cancels its active RPC and preserves sibling calls (discovery: %s)',
	async (discovery, tc) => {
		let requestReceived = Promise.withResolvers<void>()
		let requestCancelled = Promise.withResolvers<void>()
		let blockedResponse = Promise.withResolvers<{}>()

		using server = new Server()
		server.add(DiscoveryServiceDefinition, {
			whoAmI(_request, context) {
				if (context.metadata['x-caller'] !== 'blocked') {
					return {}
				}

				context.signal.addEventListener('abort', () => requestCancelled.resolve(), {
					once: true,
				})
				requestReceived.resolve()
				return abortable(context.signal, blockedResponse.promise)
			},
		})

		let connectionString = await listenWithDiscovery(server)
		using driver = new Driver(connectionString, { 'ydb.sdk.enable_discovery': discovery })
		await driver.ready(tc.signal)

		let clientToClose = driver.createClient(DiscoveryServiceDefinition)
		let sibling = driver.createClient(DiscoveryServiceDefinition)
		let pendingRequest = clientToClose.whoAmI(
			{},
			{ signal: tc.signal, metadata: { 'x-caller': 'blocked' } }
		)
		await abortable(tc.signal, requestReceived.promise)

		clientToClose.close()
		clientToClose.close()

		await expect(pendingRequest).rejects.toThrow('Client is closed')
		await abortable(tc.signal, requestCancelled.promise)

		let siblingResponse = await sibling.whoAmI({}, { signal: tc.signal })
		expect(siblingResponse).toBeDefined()

		let driverReady = await driver.ready(tc.signal)
		expect(driverReady).toBeUndefined()
	}
)

test.for([false, true])(
	'closing a service client discards its buffered responses after OK (discovery: %s)',
	async (discovery, tc) => {
		using server = new Server()
		server.add(messagesService, {
			async *messages() {
				yield 'first'
				yield 'buffered'
			},
		})
		server.add(DiscoveryServiceDefinition, { whoAmI: () => ({}) })

		let connectionString = await listenWithDiscovery(server)
		using driver = new Driver(connectionString, { 'ydb.sdk.enable_discovery': discovery })
		await driver.ready(tc.signal)

		let client = driver.createClient(messagesService)
		let terminalStatus = Promise.withResolvers<number>()
		let stream = client.messages(
			{},
			{ signal: tc.signal, onStatus: (status) => terminalStatus.resolve(status.code) }
		)
		let responses = stream[Symbol.asyncIterator]()

		let firstResponse = await responses.next()
		expect(firstResponse).toEqual({ done: false, value: 'first' })
		let statusCode = await abortable(tc.signal, terminalStatus.promise)
		expect(statusCode).toBe(Status.OK)

		client.close()

		let nextResponse = responses.next()
		await expect(nextResponse).rejects.toThrow('Client is closed')

		let sibling = driver.createClient(DiscoveryServiceDefinition)
		let siblingResponse = await sibling.whoAmI({}, { signal: tc.signal })
		expect(siblingResponse).toBeDefined()
	}
)

test.for([false, true])(
	'closing a service client cancels only its shared token wait (discovery: %s)',
	async (discovery, tc) => {
		let tokenRequested = Promise.withResolvers<void>()
		let refreshedToken = Promise.withResolvers<string>()
		let refreshPending = false
		let credentialsProvider: CredentialsProvider = {
			getToken(): Promise<string> {
				if (!refreshPending) {
					return Promise.resolve('initial-token')
				}

				tokenRequested.resolve()
				return refreshedToken.promise
			},
		}

		let receivedCallers: unknown[] = []
		using server = new Server()
		server.add(DiscoveryServiceDefinition, {
			whoAmI(_request, context) {
				receivedCallers.push(context.metadata['x-caller'])
				return {}
			},
		})

		let connectionString = await listenWithDiscovery(server)
		using driver = new Driver(connectionString, {
			'ydb.sdk.enable_discovery': discovery,
			credentialsProvider,
		})
		await driver.ready(tc.signal)
		refreshPending = true

		let clientToClose = driver.createClient(DiscoveryServiceDefinition)
		let sibling = driver.createClient(DiscoveryServiceDefinition)
		let pendingRequest = clientToClose.whoAmI(
			{},
			{ signal: tc.signal, metadata: { 'x-caller': 'closed' } }
		)
		await abortable(tc.signal, tokenRequested.promise)
		let siblingRequest = sibling.whoAmI(
			{},
			{ signal: tc.signal, metadata: { 'x-caller': 'sibling' } }
		)

		clientToClose.close()

		await expect(pendingRequest).rejects.toThrow('Client is closed')
		expect(receivedCallers).toEqual([])

		refreshedToken.resolve('shared-token')
		let siblingResponse = await siblingRequest
		expect(siblingResponse).toBeDefined()
		expect(receivedCallers).toEqual(['sibling'])
	}
)
