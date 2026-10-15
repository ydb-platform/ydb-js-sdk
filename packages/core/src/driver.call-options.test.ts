import { InterceptingCall, type Interceptor, type Metadata } from '@grpc/grpc-js'
import { CredentialsProvider } from '@ydbjs/auth'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { expect, test } from 'vitest'

import { createTestServer } from '../../../tests/grpc-server.ts'
import { Driver } from './driver.js'

class TestCredentials extends CredentialsProvider {
	async getToken(): Promise<string> {
		return 'test-token'
	}
}

let addHeader: Interceptor = (options, nextCall) =>
	new InterceptingCall(nextCall(options), {
		start(metadata, listener, next) {
			metadata = metadata.clone()
			metadata.set('x-per-call', 'present')
			next(metadata, listener)
		},
	})

// The loopback peer exposes headers that YDB does not return to the caller.
async function checkHeaders(provider: boolean, signal: AbortSignal) {
	let received: Metadata | undefined
	await using server = createTestServer()
	server.add(
		{ whoAmI: DiscoveryServiceDefinition.whoAmI },
		{
			async whoAmI(_request, context) {
				received = context.metadata
				return {}
			},
		}
	)
	let port = await server.listen()
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		credentialsProvider: new TestCredentials(),
	})
	await driver.ready(signal)
	let options = provider
		? { signal, interceptor_providers: [() => addHeader] }
		: { signal, interceptors: [addHeader] }
	let original = { ...options }
	Object.freeze(options.interceptors ?? options.interceptor_providers)
	Object.freeze(options)

	await driver.createClient(DiscoveryServiceDefinition).whoAmI({}, options)

	expect(received?.get('x-per-call')).toEqual(['present'])
	expect(received?.get('x-ydb-auth-ticket')).toEqual(['test-token'])
	expect(received?.get('x-ydb-database')).toEqual(['/local'])
	expect(received?.get('x-ydb-sdk-build-info')[0]).toEqual(expect.any(String))
	expect(received?.get('x-ydb-application-name')).toEqual([driver.application])
	expect(options).toEqual(original)
}

test('preserves driver credentials and headers with a per-call interceptor', async (tc) => {
	expect.assertions(6)
	await checkHeaders(false, tc.signal)
})

test('preserves driver credentials and headers with a per-call interceptor provider', async (tc) => {
	expect.assertions(6)
	await checkHeaders(true, tc.signal)
})
