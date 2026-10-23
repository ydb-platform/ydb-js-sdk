import { CredentialsProvider } from '@ydbjs/auth'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { type Metadata, Server, Status } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import pkg from '../package.json' with { type: 'json' }

import { Driver } from './driver.js'
import { addMetadataHook } from './metadata-hooks.js'

class TestCredentials extends CredentialsProvider {
	async getToken(): Promise<string> {
		return 'test-token'
	}
}

// The loopback peer exposes headers that YDB does not return to the caller.
test('keeps mandatory headers and auth after caller metadata and metadata hooks', async (tc) => {
	let received: Metadata | undefined
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		async whoAmI(_request, context) {
			received = context.metadata
			return {}
		},
	})
	let port = await server.listen()
	using _ = addMetadataHook((metadata) => {
		metadata['x-hook'] = 'present'
		metadata['X-YDB-DATABASE'] = '/hook-database'
		metadata['X-YDB-AUTH-TICKET'] = 'hook-token'
		metadata['X-YDB-SDK-BUILD-INFO'] = 'hook-build'
		metadata['X-YDB-APPLICATION-NAME'] = 'hook-application'
	})
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new TestCredentials(),
	})
	let metadata = Object.freeze({
		'x-caller': 'present',
		'x-ydb-database': '/caller',
		'X-YDB-DATABASE': '/caller-uppercase',
		'x-ydb-auth-ticket': 'caller-token',
		'X-YDB-AUTH-TICKET': 'caller-uppercase-token',
		'x-ydb-sdk-build-info': 'caller-build',
		'X-YDB-SDK-BUILD-INFO': 'caller-uppercase-build',
		'x-ydb-application-name': 'caller-application',
		'X-YDB-APPLICATION-NAME': 'caller-uppercase-application',
	})
	let options = Object.freeze({ signal: tc.signal, metadata })
	let client = driver.createClient(DiscoveryServiceDefinition)

	await client.whoAmI({}, options)

	expect(received?.['x-hook']).toBe('present')
	expect(received?.['x-caller']).toBe('present')
	expect(received?.['x-ydb-auth-ticket']).toBe('test-token')
	expect(received?.['x-ydb-database']).toBe('/local')
	expect(received?.['x-ydb-sdk-build-info']).toBe(`ydb-js-sdk/${pkg.version}`)
	expect(received?.['x-ydb-application-name']).toBe(driver.application)
	expect(options.metadata).toBe(metadata)
})

test('preserves repeated caller metadata with differently cased keys', async (tc) => {
	let received: Metadata | undefined
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		async whoAmI(_request, context) {
			received = context.metadata
			return {}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let first = Buffer.from('first')
	let second = Buffer.from('second')
	let third = Buffer.from('third')
	let binaryValues = Object.freeze([second, third])
	let textValues = Object.freeze(['first', 'second'])
	let metadata = Object.freeze({
		'X-Review-Bin': first,
		'x-review-bin': binaryValues,
		'X-Review-Text': textValues,
		'x-review-text': 'third',
	})
	let client = driver.createClient(DiscoveryServiceDefinition)

	await client.whoAmI({}, { metadata, signal: tc.signal })

	expect(received?.['x-review-bin']).toEqual([first, second, third])
	expect(received?.['x-review-text']).toEqual(['first', 'second', 'third'])
	expect(metadata['X-Review-Bin']).toBe(first)
	expect(metadata['x-review-bin']).toBe(binaryValues)
	expect(metadata['X-Review-Text']).toBe(textValues)
	expect(binaryValues).toEqual([second, third])
	expect(textValues).toEqual(['first', 'second'])
})

test('preserves repeated metadata added by hooks with differently cased keys', async (tc) => {
	let received: Metadata | undefined
	let beforeHook: Metadata | undefined
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		async whoAmI(_request, context) {
			received = context.metadata
			return {}
		},
	})
	let port = await server.listen()
	let first = Buffer.from('first')
	let second = Buffer.from('second')
	let third = Buffer.from('third')
	let binaryValues = Object.freeze([first, second])
	let textValues = Object.freeze(['second', 'third'])
	using _ = addMetadataHook((metadata) => {
		beforeHook = { ...metadata }
		metadata['X-Review-Bin'] = third
		metadata['X-Review-Text'] = textValues
	})
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let metadata = Object.freeze({
		'X-Review-Bin': binaryValues,
		'X-Review-Text': 'first',
	})
	let client = driver.createClient(DiscoveryServiceDefinition)

	await client.whoAmI({}, { metadata, signal: tc.signal })

	expect(beforeHook?.['x-review-bin']).toBe(binaryValues)
	expect(beforeHook?.['x-review-text']).toBe('first')
	expect(received?.['x-review-bin']).toEqual([first, second, third])
	expect(received?.['x-review-text']).toEqual(['first', 'second', 'third'])
	expect(metadata['X-Review-Bin']).toBe(binaryValues)
	expect(binaryValues).toEqual([first, second])
	expect(textValues).toEqual(['second', 'third'])
})

test('keeps registered metadata hooks in an existing driver after registration disposal', async (tc) => {
	let observed: Array<Metadata[string] | undefined> = []
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		async whoAmI(_request, context) {
			observed.push(context.metadata['x-snapshot'])
			return {}
		},
	})
	let port = await server.listen()
	let registration = addMetadataHook((metadata) => {
		metadata['x-snapshot'] = 'retained'
	})
	using first = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	registration[Symbol.dispose]()
	using second = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	let firstClient = first.createClient(DiscoveryServiceDefinition)
	let secondClient = second.createClient(DiscoveryServiceDefinition)

	await firstClient.whoAmI({}, { signal: tc.signal })
	await secondClient.whoAmI({}, { signal: tc.signal })

	expect(observed).toEqual(['retained', undefined])
})

test('cancels authentication before opening an RPC when a token provider ignores the signal', async (tc) => {
	let entered = Promise.withResolvers<void>()
	let token = Promise.withResolvers<string>()
	let calls = 0
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		async whoAmI() {
			calls++
			return {}
		},
	})
	let port = await server.listen()
	let providerSignal: AbortSignal | undefined
	class PendingCredentials extends CredentialsProvider {
		getToken(_force?: boolean, signal?: AbortSignal): Promise<string> {
			providerSignal = signal
			entered.resolve()
			return token.promise
		}
	}
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new PendingCredentials(),
	})
	let controller = new AbortController()
	let reason = new Error('caller cancelled token wait')
	let signal = AbortSignal.any([tc.signal, controller.signal])
	let client = driver.createClient(DiscoveryServiceDefinition)

	let pending = client.whoAmI({}, { signal })
	await entered.promise

	controller.abort(reason)

	await expect(pending).rejects.toBe(reason)
	expect(providerSignal?.aborted).toBe(true)
	token.resolve('late-token')
	await new Promise<void>((resolve) => setImmediate(resolve))
	expect(calls).toBe(0)
})

test('applies the RPC deadline while credentials are pending', async (tc) => {
	let providerSignal: AbortSignal | undefined
	class PendingCredentials extends CredentialsProvider {
		getToken(_force?: boolean, signal?: AbortSignal): Promise<string> {
			providerSignal = signal
			return new Promise(() => {})
		}
	}
	using driver = new Driver('grpc://127.0.0.1:1/local', {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new PendingCredentials(),
	})
	let client = driver.createClient(DiscoveryServiceDefinition)

	let pending = client.whoAmI({}, { signal: tc.signal, deadline: Date.now() + 30 })

	await expect(pending).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED })
	expect(providerSignal?.aborted).toBe(true)
})

test('does not abort completed credential requests when the RPC ends', async (tc) => {
	let providerSignal: AbortSignal | undefined
	class RefreshingCredentials extends CredentialsProvider {
		async getToken(_force?: boolean, signal?: AbortSignal): Promise<string> {
			providerSignal = signal
			return 'cached-token'
		}
	}
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		async whoAmI() {
			return {}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new RefreshingCredentials(),
	})
	let client = driver.createClient(DiscoveryServiceDefinition)

	await client.whoAmI({}, { signal: tc.signal })
	driver.close()

	expect(providerSignal?.aborted).toBe(false)
})

test('reports credential failures without opening an unauthenticated RPC', async (tc) => {
	let calls = 0
	let failure = new Error('token unavailable')
	class FailingCredentials extends CredentialsProvider {
		async getToken(): Promise<string> {
			throw failure
		}
	}
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		async whoAmI() {
			calls++
			return {}
		},
	})
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new FailingCredentials(),
	})
	let client = driver.createClient(DiscoveryServiceDefinition)

	let pending = client.whoAmI({}, { signal: tc.signal })

	await expect(pending).rejects.toBe(failure)
	expect(calls).toBe(0)
})
