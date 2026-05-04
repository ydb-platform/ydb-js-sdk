import { afterEach, expect, test, vi } from 'vitest'
import { channel as dc, tracingChannel } from 'node:diagnostics_channel'

import { ServiceAccountCredentialsProvider, type ServiceAccountKey } from './service-account.js'

// Same 2048-bit RSA private key used in service-account.test.ts.
let mockKey: ServiceAccountKey = {
	id: 'ajexxxxxxxxxxxxxxxxx',
	service_account_id: 'ajexxxxxxxxxxxxxxxxx',
	private_key: `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCbreZrDAxMCwwt
heq4OyYSaUXlBB+6zIRVIG3/VUFE18DSRzIotkw10nsRBAceSfdY6196Yoz8iOjU
IOWG7Cjfl4iWzRQjsavN5WVtjnhexXr5DylEORVE5gsuxtYCThRcKF7Q0WAxrsAx
cKYYEjNs1uppOKEAP2XTTuTFfc57uamrKCzGbAy5JSqgQVL8anTJ5JJTN+r+oDaD
hzUH6nU9df4Yc+8c4B1FzGq4Sl6IBH0Dtf3VizBTeGAgkxfeiMSDo/kd3gdyzmL2
lyqT6WZNn7HuGOw7TTtqantwjeE0dLEg4gKPzviTpB7DipYRJmTD9+3SfYl6AKPc
ZXLGbIn3AgMBAAECggEARcE8zlg+plAI69jmXBg8reE3rS8U3IlI/i+iudbEgQk/
X7kA85cDPNaLyAsK+Xpg9xm31UmVLI5X7Ly0u6jTg6QNUqyfSoMQnRgdQ2Kj8qr/
t9sgPW5qZk3BUvtK5wt/Oe/o1B4MwRYxDbYQ5hY5rpn5vJ3gHhFKGc1u2kLNo0fR
TeLhJuACksfJzViRQv/69X1H+/g4PTUB1fCWGvxcSryD34cpSI8wzQ91Xt14L/3j
kvMlFKv9xfZYrNdoIeGtM8EWpomMO2POr6FPs2gGVbfPzDzQgZqoc2ScaRB2+WsS
CX/JKAAWNKOa+dEMfapYSdNyV8Dli/QWJ4MzsBvr0QKBgQDUShNWbMiLFNZZ520p
RrA/ZJQe+vehFkplh6nX8YnkQ4OaM3d99h/lTkLxkD7xV+vHLs6YIaYPsTMBB4Ta
ky3js3X82PxvWiiUoIG/i4bIxg9fJY70eSrd6nFhYsI08LS99KKu5qhZpSkjg8wX
8+U2FlwPefBWlrhzJZYc7lZO+QKBgQC7u94bMn58iPTwFDcCbBgeJCDzl0wDLQMr
r1gngKBesxk0nfzPToSBwLMLhI0fJnipsGeX2XWsqRrQZMCJkH1CvLgFQHEt55DW
wP/h0Op1lif7x1bZN00FcLmYB6IWn6K7fKUg1mT6Vzomaoo1fP7f62UIHsI+jbpk
sYhRYLmsbwKBgGL4rg9K5CxDaLO9e10VAbJsV8ohwzUsyT6QgxSUHW94MnC/sePd
zX0AgaFRWKb4EIpqPhMbDOqf+GFwefXVTD2uO0HIf9gCNo0kT5lXmV0dSalYP0+m
9d9EH9wBSP2ZgwpUdUwJaU9x+r3+AjbglGok/oKQnQYhepjkWxnd3AsxAoGALyFi
CEfr803a2C7rBIOopmCBmUXhgmaZhi0WH4yuNjgWWtxS7KSUpZKAIKMdXrWk000D
JN8mKLunjKvOnnqUx91jAYaFI3YgKZn4Y3O0eOLClPYdepjkkDoVjfJUogNfslv/
hLfuT974LU7P9c+0mPiau6glMdkY81CSnYN/+acCgYBECj8LvJzv+XQ0maNPBLtg
gwodhiizlzVuQ5Rd9FLK6dtVRv1LLrycf6f9LPCN33EiEwrmMst8dHWXgsvBvLyh
nvtD9shYTO/sNlqeMph4NmocaLnEqd84EGVdmPMJXmnkJGmnivd9nW7rknff9hdo
qmi1rcP923/IkrkU3VQCUw==
-----END PRIVATE KEY-----`,
}

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

function mockOkResponse(expiresInMs = 3600 * 1000) {
	global.fetch = vi.fn(async () => {
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.xxxxxxxxxxxxxxx',
				expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
}

test('traces yc-service-account getToken via tracing:ydb:auth.token.fetch', async () => {
	mockOkResponse()
	using trace = collectTrace('tracing:ydb:auth.token.fetch')

	let provider = new ServiceAccountCredentialsProvider(mockKey)
	await provider.getToken(true)

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(trace.error).toHaveLength(0)
	expect(trace.start[0]).toMatchObject({ provider: 'yc-service-account' })
})

test('publishes ydb:auth.token.refreshed with expiresAt for yc-service-account', async () => {
	let before = Date.now()
	mockOkResponse(60_000)
	using refreshed = collect('ydb:auth.token.refreshed')

	let provider = new ServiceAccountCredentialsProvider(mockKey)
	await provider.getToken(true)

	expect(refreshed.payloads).toHaveLength(1)
	let p = refreshed.payloads[0] as any
	expect(p.provider).toBe('yc-service-account')
	expect(typeof p.expiresAt).toBe('number')
	expect(p.expiresAt).toBeGreaterThanOrEqual(before + 60_000)
})

test('opportunistic background refresh emits the same tracing/publish events as a forced refresh', async () => {
	// First getToken populates the cache with a near-expiry token (within
	// the 5-minute refresh window) so the next getToken returns immediately
	// and triggers #refreshTokenInBackground.
	mockOkResponse(4 * 60 * 1000)
	let provider = new ServiceAccountCredentialsProvider(mockKey)
	await provider.getToken(true)

	using fetchTrace = collectTrace('tracing:ydb:auth.token.fetch')
	using refreshed = collect('ydb:auth.token.refreshed')

	mockOkResponse(60 * 60 * 1000) // background refresh returns a fresh token

	await provider.getToken() // returns cached, kicks off background refresh

	// Drain microtasks/timers so the background fetch settles before assert.
	await new Promise((r) => setTimeout(r, 50))

	expect(fetchTrace.start.length).toBeGreaterThanOrEqual(1)
	expect(fetchTrace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(fetchTrace.error).toHaveLength(0)
	expect(fetchTrace.start[0]).toMatchObject({ provider: 'yc-service-account' })
	expect(refreshed.payloads.length).toBeGreaterThanOrEqual(1)
})

test('failed background refresh publishes ydb:auth.provider.failed without breaking the cached token', async () => {
	mockOkResponse(4 * 60 * 1000)
	let provider = new ServiceAccountCredentialsProvider(mockKey)
	let cached = await provider.getToken(true)

	using failed = collect('ydb:auth.provider.failed')

	// Background fetch fails — provider must still return the cached token.
	global.fetch = vi.fn(async () => new Response('forbidden', { status: 403 }))

	let token = await provider.getToken()
	expect(token).toBe(cached)

	await new Promise((r) => setTimeout(r, 50))

	expect(failed.payloads.length).toBeGreaterThanOrEqual(1)
	expect(failed.payloads[0]).toMatchObject({ provider: 'yc-service-account' })
})

test('publishes ydb:auth.provider.failed when IAM API rejects the JWT', async () => {
	global.fetch = vi.fn(async () => new Response('forbidden', { status: 403 }))
	using failed = collect('ydb:auth.provider.failed')

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	await expect(provider.getToken(true, AbortSignal.timeout(200))).rejects.toThrow(
		/IAM API error|aborted/i
	)

	expect(failed.payloads.length).toBeGreaterThanOrEqual(1)
	let p = failed.payloads[0] as any
	expect(p.provider).toBe('yc-service-account')
	expect(p.error).toBeDefined()
})
