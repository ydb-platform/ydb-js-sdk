import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import { DiscoveryServiceDefinition, ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { CredentialsProvider } from '@ydbjs/auth'
import { Server } from '@ydbjs/grpc'
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
	'close cancels pending authentication before opening an RPC (discovery: %s)',
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

		expect(providerSignal?.aborted).toBe(true)
		await expect(request).rejects.toThrow('Driver is closed')
		token.resolve('late-token')
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(calls).toBe(0)
	}
)
