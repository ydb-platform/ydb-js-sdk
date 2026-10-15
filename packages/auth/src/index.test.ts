import { create } from '@bufbuild/protobuf'
import { DiscoveryServiceDefinition, WhoAmIResponseSchema } from '@ydbjs/api/discovery'
import { Client, Metadata, credentials, status } from '@grpc/grpc-js'
import { createServiceClient } from '@ydbjs/api/client'
import { createTestServer } from '../../../tests/grpc-server.ts'
import { expect, test } from 'vitest'

import { CredentialsProvider } from './index.ts'

// A controllable provider isolates cancellation during token acquisition from server timing.
async function fixture(getToken: CredentialsProvider['getToken']) {
	class Provider extends CredentialsProvider {
		override getToken = getToken
	}

	let server = createTestServer()
	let received: Record<string, string | undefined> | undefined
	server.add(
		{ whoAmI: DiscoveryServiceDefinition.whoAmI },
		{
			async whoAmI(_request, context) {
				received = {
					token: context.metadata.get('x-ydb-auth-ticket')[0] as string | undefined,
					existing: context.metadata.get('x-existing')[0] as string | undefined,
				}
				return create(WhoAmIResponseSchema, {})
			},
		}
	)

	let port = await server.listen('127.0.0.1:0')
	let client = createServiceClient(
		DiscoveryServiceDefinition,
		new Client(`127.0.0.1:${port}`, credentials.createInsecure(), {
			interceptors: [new Provider().interceptor],
		})
	)

	return {
		client,
		get received() {
			return received
		},
		async [Symbol.asyncDispose]() {
			client.close()
			await server.shutdown()
		},
	}
}

test('attaches credentials while preserving caller metadata', async (tc) => {
	await using server = await fixture(async () => 'secret-token')
	let metadata = new Metadata()
	metadata.set('x-existing', 'value')
	metadata.set('x-ydb-auth-ticket', 'stale-token')

	await server.client.whoAmI({}, { metadata, signal: tc.signal })

	expect(server.received).toEqual({ token: 'secret-token', existing: 'value' })
	expect(metadata.getMap()).toEqual({ 'x-existing': 'value', 'x-ydb-auth-ticket': 'stale-token' })
})

test('cancels a call while its credentials provider is pending', async () => {
	let started = Promise.withResolvers<void>()
	let pending = Promise.withResolvers<string>()
	let providerSignal: AbortSignal | undefined
	await using server = await fixture((_force, signal) => {
		providerSignal = signal
		started.resolve()
		return pending.promise
	})
	let controller = new AbortController()
	let response = server.client.whoAmI({}, { signal: controller.signal })
	await started.promise

	controller.abort(new Error('cancelled by caller'))
	await expect(response).rejects.toThrow('cancelled by caller')

	expect(providerSignal?.aborted).toBe(true)
	pending.resolve('late-token')
	await new Promise((resolve) => setImmediate(resolve))
	expect(server.received).toBeUndefined()
})

test('honors a native deadline while its credentials provider ignores cancellation', async () => {
	let providerSignal: AbortSignal | undefined
	await using server = await fixture((_force, signal) => {
		providerSignal = signal
		return new Promise(() => {})
	})

	await expect(server.client.whoAmI({}, { deadline: Date.now() + 30 })).rejects.toMatchObject({
		code: status.DEADLINE_EXCEEDED,
	})

	expect(providerSignal?.aborted).toBe(true)
	expect(server.received).toBeUndefined()
})

test('reports provider failures without sending an unauthenticated RPC', async (tc) => {
	await using server = await fixture(async () => {
		throw new Error('token unavailable')
	})

	await expect(server.client.whoAmI({}, { signal: tc.signal })).rejects.toMatchObject({
		code: status.UNKNOWN,
		details: expect.stringContaining('token unavailable'),
	})

	expect(server.received).toBeUndefined()
})

test('preserves native per-call credentials alongside the YDB token', async (tc) => {
	await using server = await fixture(async () => 'secret-token')
	let extraCredentials = credentials.createFromMetadataGenerator((_params, callback) => {
		let metadata = new Metadata()
		metadata.set('x-existing', 'native-credential')
		callback(null, metadata)
	})

	await server.client.whoAmI({}, { credentials: extraCredentials, signal: tc.signal })

	expect(server.received).toEqual({ token: 'secret-token', existing: 'native-credential' })
})
