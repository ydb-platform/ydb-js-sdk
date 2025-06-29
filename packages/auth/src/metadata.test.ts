import { afterEach, expect, test, vi } from "vitest";

import { MetadataCredentialsProvider } from "./metadata.ts";

afterEach(() => {
	vi.restoreAllMocks()
})

test('extracts valid token', async () => {
	global.fetch = vi.fn(async () => {
		let response = new Response(JSON.stringify({ access_token: 'test-token' }))
		response.headers.set('Content-Type', 'application/json')

		return response
	})

	let provider = new MetadataCredentialsProvider({})

	let token = await provider.getToken(true)
	expect(token, 'Token is not empty').eq('test-token')
})

test('handles invalid response', async () => {
	global.fetch = vi.fn(async () => {
		let response = new Response('404 Not Found', { status: 404 })

		return response
	})

	let provider = new MetadataCredentialsProvider({})

	let result = provider.getToken(true, AbortSignal.timeout(100))
	await expect(result).rejects.toThrow('The operation was aborted')
})
