import { afterEach, expect, test, vi } from 'vitest'
import { channel as dc, tracingChannel } from 'node:diagnostics_channel'
import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { ServerError, Status, createServer } from 'nice-grpc'

import { AuthServiceDefinition, LoginResponseSchema, LoginResultSchema } from '@ydbjs/api/auth'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'

import { MetadataCredentialsProvider } from './metadata.js'
import { StaticCredentialsProvider } from './static.js'

afterEach(() => {
	vi.restoreAllMocks()
})

/** Subscribe to a plain channel; returned object is `Disposable`. */
function collect(name: string): { payloads: unknown[] } & Disposable {
	let payloads: unknown[] = []
	let fn = (msg: unknown) => payloads.push(structuredClone(msg))
	dc(name).subscribe(fn)
	return {
		payloads,
		[Symbol.dispose]() {
			dc(name).unsubscribe(fn)
		},
	}
}

/** Subscribe to a tracing channel; capture start / asyncEnd / error contexts. */
function collectTrace(name: string): {
	start: object[]
	asyncEnd: object[]
	error: (object & { error: unknown })[]
} & Disposable {
	let ch = tracingChannel(name)
	let start: object[] = []
	let asyncEnd: object[] = []
	let error: (object & { error: unknown })[] = []
	let handlers = {
		start: (ctx: any) => start.push({ ...ctx }),
		asyncEnd: (ctx: any) => asyncEnd.push({ ...ctx }),
		error: (ctx: any) => error.push({ ...ctx }),
	}
	ch.subscribe(handlers as any)
	return {
		start,
		asyncEnd,
		error,
		[Symbol.dispose]() {
			ch.unsubscribe(handlers as any)
		},
	}
}

// ── metadata ────────────────────────────────────────────────────────────────

test('traces metadata getToken via tracing:ydb:auth.token.fetch', async () => {
	global.fetch = vi.fn(async () => {
		let response = new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	using trace = collectTrace('tracing:ydb:auth.token.fetch')

	let provider = new MetadataCredentialsProvider({})
	await provider.getToken(true)

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(trace.error).toHaveLength(0)
	expect(trace.start[0]).toMatchObject({ provider: 'metadata' })
})

test('publishes ydb:auth.token.refreshed with expiresAt for metadata provider', async () => {
	let before = Date.now()
	global.fetch = vi.fn(async () => {
		let response = new Response(JSON.stringify({ access_token: 'tok', expires_in: 60 }))
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	using refreshed = collect('ydb:auth.token.refreshed')

	let provider = new MetadataCredentialsProvider({})
	await provider.getToken(true)

	expect(refreshed.payloads).toHaveLength(1)
	let p = refreshed.payloads[0] as any
	expect(p.provider).toBe('metadata')
	expect(typeof p.expiresAt).toBe('number')
	// expiresAt should be roughly now + 60s in unix ms
	expect(p.expiresAt).toBeGreaterThanOrEqual(before + 60_000)
})

test('publishes ydb:auth.provider.failed when metadata fetch fails', async () => {
	global.fetch = vi.fn(async () => new Response('boom', { status: 500 }))
	using failed = collect('ydb:auth.provider.failed')

	let provider = new MetadataCredentialsProvider({})

	await expect(provider.getToken(true, AbortSignal.timeout(50))).rejects.toThrow(
		/aborted|fetch token|abort/i
	)

	expect(failed.payloads).toHaveLength(1)
	let p = failed.payloads[0] as any
	expect(p.provider).toBe('metadata')
	expect(p.error).toBeDefined()
})

test('publishes ydb:auth.token.expired once per incident across concurrent metadata calls', async () => {
	// First call: server gives a token that expires immediately.
	let nowSeconds = 0
	global.fetch = vi.fn(async () => {
		nowSeconds++
		let response = new Response(
			JSON.stringify({ access_token: `tok-${nowSeconds}`, expires_in: 0 })
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})

	let provider = new MetadataCredentialsProvider({})
	await provider.getToken(true)

	using expired = collect('ydb:auth.token.expired')

	// Three concurrent calls observe the same expired cached token.
	await Promise.all([
		provider.getToken(false).catch(() => {}),
		provider.getToken(false).catch(() => {}),
		provider.getToken(false).catch(() => {}),
	])

	// Single incident → single event (others piggyback the in-flight refresh).
	expect(expired.payloads).toHaveLength(1)
	let p = expired.payloads[0] as any
	expect(p.provider).toBe('metadata')
	expect(typeof p.stalenessMs).toBe('number')
	expect(p.stalenessMs).toBeGreaterThanOrEqual(0)
})

// ── static ──────────────────────────────────────────────────────────────────

async function startAuthServer(opts: { fail?: boolean } = {}) {
	let server = createServer()

	server.add(
		{ login: AuthServiceDefinition.login },
		{
			async login() {
				if (opts.fail) {
					throw new ServerError(Status.UNAUTHENTICATED, 'login boom')
				}
				// Plain string — not a JWT — forces the StaticCredentialsProvider
				// fallback branch (5-minute synthetic exp).
				let result = create(LoginResultSchema, { token: 'opaque-token' })
				return create(LoginResponseSchema, {
					operation: {
						status: StatusIds_StatusCode.SUCCESS,
						ready: true,
						result: anyPack(LoginResultSchema, result),
					} as any,
				})
			},
		}
	)

	let port = await server.listen('127.0.0.1:0')
	return {
		endpoint: `grpc://127.0.0.1:${port}`,
		async [Symbol.asyncDispose]() {
			await server.shutdown()
		},
	}
}

test('traces static getToken via tracing:ydb:auth.token.fetch', async () => {
	await using server = await startAuthServer()
	using trace = collectTrace('tracing:ydb:auth.token.fetch')

	let provider = new StaticCredentialsProvider({ username: 'u', password: 'p' }, server.endpoint)
	await provider.getToken(true)

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(trace.error).toHaveLength(0)
	expect(trace.start[0]).toMatchObject({ provider: 'static' })
})

test('publishes ydb:auth.token.refreshed with expiresAt for static provider', async () => {
	let before = Date.now()
	await using server = await startAuthServer()
	using refreshed = collect('ydb:auth.token.refreshed')

	let provider = new StaticCredentialsProvider({ username: 'u', password: 'p' }, server.endpoint)
	await provider.getToken(true)

	expect(refreshed.payloads).toHaveLength(1)
	let p = refreshed.payloads[0] as any
	expect(p.provider).toBe('static')
	// Token 'a.b.c' is not a valid JWT — fallback expiry is 5 minutes from now.
	expect(p.expiresAt).toBeGreaterThanOrEqual(before + 4 * 60_000)
})

test('publishes ydb:auth.provider.failed when static login fails', async () => {
	await using server = await startAuthServer({ fail: true })
	using failed = collect('ydb:auth.provider.failed')

	let provider = new StaticCredentialsProvider({ username: 'u', password: 'p' }, server.endpoint)

	await expect(provider.getToken(true, AbortSignal.timeout(200))).rejects.toThrow(
		/login boom|aborted/i
	)

	expect(failed.payloads.length).toBeGreaterThanOrEqual(1)
	let p = failed.payloads[0] as any
	expect(p.provider).toBe('static')
	expect(p.error).toBeDefined()
})
