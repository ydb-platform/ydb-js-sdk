import { expect, test } from 'vitest'

import { CredentialsProvider } from './index.ts'

class FakeCredentialsProvider extends CredentialsProvider {
	#token: string

	constructor(token: string) {
		super()
		this.#token = token
	}

	async getToken(): Promise<string> {
		return this.#token
	}
}

test('attaches the token as x-ydb-auth-ticket on the outgoing call', async () => {
	let provider = new FakeCredentialsProvider('secret-token')

	let seenMetadata: any
	let call = {
		method: { path: '/test/Method' },
		requestStream: false as const,
		responseStream: false as const,
		request: undefined,
		async *next(_request: unknown, options: any) {
			seenMetadata = options.metadata
			yield 'response'
			return 'response'
		},
	}

	let gen = provider.middleware(call as any, {})
	for await (let chunk of gen) void chunk

	expect(seenMetadata.get('x-ydb-auth-ticket')).toBe('secret-token')
})

test('preserves existing metadata and call options', async () => {
	let provider = new FakeCredentialsProvider('secret-token')

	let seenMetadata: any
	let seenSignal: AbortSignal | undefined
	let call = {
		method: { path: '/test/Method' },
		requestStream: false as const,
		responseStream: false as const,
		request: undefined,
		async *next(_request: unknown, options: any) {
			seenMetadata = options.metadata
			seenSignal = options.signal
			yield 'response'
			return 'response'
		},
	}

	let controller = new AbortController()
	let gen = provider.middleware(call as any, {
		metadata: { 'x-existing': 'value' } as any,
		signal: controller.signal,
	})
	for await (let chunk of gen) void chunk

	expect(seenMetadata.get('x-existing')).toBe('value')
	expect(seenMetadata.get('x-ydb-auth-ticket')).toBe('secret-token')
	expect(seenSignal).toBe(controller.signal)
})
