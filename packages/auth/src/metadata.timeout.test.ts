import { channel, tracingChannel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { type ServerResponse, createServer } from 'node:http'

import { abortable } from '@ydbjs/abortable'
import { expect, test, vi } from 'vitest'

import { MetadataCredentialsProvider } from './metadata.ts'

let providerFailures = channel('ydb:auth.provider.failed')

// A local endpoint keeps response timing under test control without replacing fetch.
test('cancels initiating and joining waits without cancelling the shared metadata fetch', async (tc) => {
	let started = Promise.withResolvers<ServerResponse>()
	let requests = 0
	await using server = createServer((_request, response) => {
		requests++
		started.resolve(response)
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening', { signal: tc.signal })
	let address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected metadata server address')
	let provider = new MetadataCredentialsProvider({ endpoint: `http://127.0.0.1:${address.port}` })
	let initiating = new AbortController()
	let joining = new AbortController()
	let firstReason = new Error('Initiating caller cancelled')
	let secondReason = new Error('Joining caller cancelled')
	using timeout = vi.spyOn(AbortSignal, 'timeout')
	let first = provider.getToken(false, initiating.signal)
	let second = provider.getToken(false, joining.signal)
	let surviving = provider.getToken(false, tc.signal)
	void first.catch(() => {})
	void second.catch(() => {})
	let response = await abortable(tc.signal, started.promise)

	initiating.abort(firstReason)
	joining.abort(secondReason)
	await expect(first).rejects.toBe(firstReason)
	await expect(second).rejects.toBe(secondReason)
	expect(response.destroyed).toBe(false)
	expect(requests).toBe(1)

	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify({ access_token: 'shared-token', expires_in: 600 }))
	expect(await surviving).toBe('shared-token')
	expect(await provider.getToken()).toBe('shared-token')
	expect(await provider.getToken(false, tc.signal)).toBe('shared-token')
	expect(requests).toBe(1)
	expect(timeout.mock.calls).toEqual([[5000]])
})

test('rejects an already cancelled token request without contacting metadata', async (tc) => {
	let requests = 0
	await using server = createServer((_request, response) => {
		requests++
		response.end(JSON.stringify({ access_token: 'unexpected-token' }))
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening', { signal: tc.signal })
	let address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected metadata server address')
	let provider = new MetadataCredentialsProvider({ endpoint: `http://127.0.0.1:${address.port}` })
	using timeout = vi.spyOn(AbortSignal, 'timeout')
	let reason = new Error('Caller already cancelled')

	await expect(provider.getToken(false, AbortSignal.abort(reason))).rejects.toBe(reason)
	expect(requests).toBe(0)
	expect(timeout).not.toHaveBeenCalled()
})

test('bounds a shared metadata fetch by its own timeout after all callers cancel', async (tc) => {
	let started = Promise.withResolvers<ServerResponse>()
	let requests = 0
	await using server = createServer((_request, response) => {
		requests++
		started.resolve(response)
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening', { signal: tc.signal })
	let address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected metadata server address')
	let provider = new MetadataCredentialsProvider({ endpoint: `http://127.0.0.1:${address.port}` })
	let caller = new AbortController()
	let reason = new Error('Caller cancelled')
	using timeout = vi.spyOn(AbortSignal, 'timeout')
	let cancelled = provider.getToken(false, caller.signal)
	void cancelled.catch(() => {})
	let response = await abortable(tc.signal, started.promise)
	caller.abort(reason)
	await expect(cancelled).rejects.toBe(reason)
	expect(response.destroyed).toBe(false)

	let later = provider.getToken(false, tc.signal)
	await expect(later).rejects.toMatchObject({ name: 'TimeoutError' })
	await expect.poll(() => response.destroyed).toBe(true)
	expect(requests).toBe(1)
	expect(timeout.mock.calls).toEqual([[5000]])
}, 10_000)

test('observes refresh failure after cancellation from a diagnostic subscriber', async (tc) => {
	let requests = 0
	await using server = createServer((_request, response) => {
		requests++
		response.writeHead(403)
		response.end('denied')
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening', { signal: tc.signal })
	let address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected metadata server address')
	let provider = new MetadataCredentialsProvider({ endpoint: `http://127.0.0.1:${address.port}` })
	let caller = new AbortController()
	let reason = new Error('Caller cancelled from a diagnostic subscriber')
	let failed = Promise.withResolvers<unknown>()
	let trace = tracingChannel('tracing:ydb:auth.token.fetch')
	let onStart = (message: unknown) => {
		if ((message as { provider: string }).provider === 'metadata') caller.abort(reason)
	}
	let onFailure = (message: unknown) => {
		let event = message as { provider: string; error: unknown }
		if (event.provider === 'metadata') failed.resolve(event.error)
	}
	trace.start.subscribe(onStart)
	providerFailures.subscribe(onFailure)
	using subscriptions = {
		[Symbol.dispose]() {
			trace.start.unsubscribe(onStart)
			providerFailures.unsubscribe(onFailure)
		},
	}
	void subscriptions

	let result = provider.getToken(false, caller.signal)

	await expect(result).rejects.toBe(reason)
	let error = await abortable(tc.signal, failed.promise)
	expect(error).toMatchObject({ message: 'Failed to fetch token: 403 Forbidden' })
	expect(requests).toBeGreaterThan(0)
	// The detached refresh must reach rejection reporting before the test ends.
	await new Promise<void>((resolve) => setImmediate(resolve))
})
