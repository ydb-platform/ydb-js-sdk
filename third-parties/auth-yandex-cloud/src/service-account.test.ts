import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ServiceAccountCredentialsProvider, type ServiceAccountKey } from './service-account.js'

// Valid RSA private key for testing (2048-bit)
// Generated with: openssl genrsa 2048
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

// Mock node:fs for ESM compatibility
vi.mock('node:fs', async () => {
	let actual = await vi.importActual('node:fs')
	return {
		...actual,
		readFileSync: vi.fn(),
	}
})

let fs: typeof import('node:fs')

beforeEach(async () => {
	fs = await import('node:fs')
	vi.mocked(fs.readFileSync).mockReset()
})

afterEach(() => {
	vi.restoreAllMocks()
})

test('creates provider with valid key', () => {
	let provider = new ServiceAccountCredentialsProvider(mockKey)
	expect(provider).toBeDefined()
})

test('throws error on invalid key', () => {
	expect(() => {
		// oxlint-disable-next-line no-new
		new ServiceAccountCredentialsProvider({ id: '', service_account_id: '', private_key: '' })
	}).toThrow('Invalid Service Account key')
})

test('fetches IAM token', async () => {
	global.fetch = vi.fn(async () => {
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.xxxxxxxxxxxxxxx',
				expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})

	let provider = new ServiceAccountCredentialsProvider(mockKey, {
		iamEndpoint: 'https://iam.api.cloud.yandex.net/iam/v1/tokens',
	})

	let token = await provider.getToken(true)
	expect(token).toBe('t1.xxxxxxxxxxxxxxx')
	expect(global.fetch).toHaveBeenCalled()
})

test('caches token and returns cached value', async () => {
	let expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

	let fetchMock = vi.fn(async () => {
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.cached-token',
				expiresAt,
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	// First call - fetches token
	let token1 = await provider.getToken()
	expect(token1).toBe('t1.cached-token')
	expect(global.fetch).toHaveBeenCalledTimes(1)

	// Second call - returns cached token
	let token2 = await provider.getToken()
	expect(token2).toBe('t1.cached-token')
	expect(global.fetch).toHaveBeenCalledTimes(1) // Still 1, not 2
})

test('handles IAM API error', async () => {
	global.fetch = vi.fn(async () => {
		return new Response('Unauthorized', { status: 401 })
	})

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	await expect(provider.getToken(true)).rejects.toThrow('IAM API error')
})

test('fromFile reads and parses JSON file', () => {
	let mockFileContent = JSON.stringify(mockKey)
	vi.mocked(fs.readFileSync).mockReturnValue(mockFileContent)

	let provider = ServiceAccountCredentialsProvider.fromFile('/path/to/key.json')
	expect(provider).toBeDefined()
	expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/key.json', 'utf8')
})

test('fromEnv reads from environment variable', () => {
	let originalEnv = process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS
	process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS = '/env/path/key.json'

	let mockFileContent = JSON.stringify(mockKey)
	vi.mocked(fs.readFileSync).mockReturnValue(mockFileContent)

	let provider = ServiceAccountCredentialsProvider.fromEnv()
	expect(provider).toBeDefined()
	expect(fs.readFileSync).toHaveBeenCalledWith('/env/path/key.json', 'utf8')

	if (originalEnv) {
		process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS = originalEnv
	} else {
		delete process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS
	}
})

test('fromEnv throws if environment variable not set', () => {
	let originalEnv = process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS
	delete process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS

	expect(() => {
		ServiceAccountCredentialsProvider.fromEnv()
	}).toThrow('YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS environment variable is not set')

	if (originalEnv) {
		process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS = originalEnv
	}
})

test('forces token refresh when force=true', async () => {
	let expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

	let fetchMock = vi.fn(async () => {
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.forced-token',
				expiresAt,
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	// First call - fetches token
	let token1 = await provider.getToken()
	expect(token1).toBe('t1.forced-token')
	expect(fetchMock).toHaveBeenCalledTimes(1)

	// Force refresh - should fetch new token even though current is valid
	let token2 = await provider.getToken(true)
	expect(token2).toBe('t1.forced-token')
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('refreshes token when expired', async () => {
	let pastExpiresAt = new Date(Date.now() - 1000).toISOString()

	let fetchMock = vi.fn(async () => {
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.expired-token',
				expiresAt: pastExpiresAt,
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	// First call - fetches expired token
	let token1 = await provider.getToken()
	expect(token1).toBe('t1.expired-token')
	expect(fetchMock).toHaveBeenCalledTimes(1)

	// Second call - token expired, should refresh
	let newExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
	fetchMock.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				iamToken: 't1.new-token',
				expiresAt: newExpiresAt,
			}),
			{ headers: { 'Content-Type': 'application/json' } }
		)
	)

	let token2 = await provider.getToken()
	expect(token2).toBe('t1.new-token')
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('starts background refresh when token expires soon', async () => {
	let expiresAt = new Date(Date.now() + 4 * 60 * 1000).toISOString() // 4 minutes

	let fetchMock = vi.fn(async () => {
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.expiring-token',
				expiresAt,
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	// First call - fetches token
	let token1 = await provider.getToken()
	expect(token1).toBe('t1.expiring-token')
	expect(fetchMock).toHaveBeenCalledTimes(1)

	// Second call - token expires in < 5 minutes, should trigger background refresh
	let newExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
	fetchMock.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				iamToken: 't1.refreshed-token',
				expiresAt: newExpiresAt,
			}),
			{ headers: { 'Content-Type': 'application/json' } }
		)
	)

	let token2 = await provider.getToken()
	expect(token2).toBe('t1.expiring-token') // Returns old token immediately
	expect(fetchMock).toHaveBeenCalledTimes(2) // Background refresh started
})

test('retries on 429 with exponential backoff', async () => {
	let attempt = 0
	let fetchMock = vi.fn(async () => {
		attempt++
		if (attempt === 1) {
			return new Response('Too Many Requests', { status: 429 })
		}
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.retry-token',
				expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	let token = await provider.getToken(true)
	expect(token).toBe('t1.retry-token')
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('retries on 503 with exponential backoff', async () => {
	let attempt = 0
	let fetchMock = vi.fn(async () => {
		attempt++
		if (attempt === 1) {
			return new Response('Service Unavailable', { status: 503 })
		}
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.retry-token',
				expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	let token = await provider.getToken(true)
	expect(token).toBe('t1.retry-token')
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('retries on 5xx with fast retry', async () => {
	let attempt = 0
	let fetchMock = vi.fn(async () => {
		attempt++
		if (attempt === 1) {
			return new Response('Internal Server Error', { status: 500 })
		}
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.retry-token',
				expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	let token = await provider.getToken(true)
	expect(token).toBe('t1.retry-token')
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('does not retry on 4xx errors', async () => {
	let fetchMock = vi.fn(async () => {
		return new Response('Bad Request', { status: 400 })
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	await expect(provider.getToken(true)).rejects.toThrow('IAM API error')
	expect(fetchMock).toHaveBeenCalledTimes(1) // No retry
})

test('retries on network errors', async () => {
	let attempt = 0
	let fetchMock = vi.fn(async () => {
		attempt++
		if (attempt === 1) {
			throw new TypeError('fetch failed')
		}
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.retry-token',
				expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})
	global.fetch = fetchMock

	let provider = new ServiceAccountCredentialsProvider(mockKey)

	let token = await provider.getToken(true)
	expect(token).toBe('t1.retry-token')
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('fromFile throws on empty file', () => {
	vi.mocked(fs.readFileSync).mockReturnValue('')

	expect(() => {
		ServiceAccountCredentialsProvider.fromFile('/path/to/empty.json')
	}).toThrow('Failed to parse Service Account key JSON')
})

test('fromFile throws on invalid JSON', () => {
	vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }')

	expect(() => {
		ServiceAccountCredentialsProvider.fromFile('/path/to/invalid.json')
	}).toThrow('Failed to parse Service Account key JSON')
})

test('fromFile throws on file read error', () => {
	vi.mocked(fs.readFileSync).mockImplementation(() => {
		throw new Error('ENOENT: no such file')
	})

	expect(() => {
		ServiceAccountCredentialsProvider.fromFile('/path/to/missing.json')
	}).toThrow('Failed to read Service Account key file')
})

test('throws error on invalid private key format', async () => {
	let invalidKey: ServiceAccountKey = {
		id: 'test-id',
		service_account_id: 'test-sa-id',
		private_key: 'invalid-key-format',
	}

	let provider = new ServiceAccountCredentialsProvider(invalidKey)

	global.fetch = vi.fn(async () => {
		let response = new Response(
			JSON.stringify({
				iamToken: 't1.token',
				expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
			})
		)
		response.headers.set('Content-Type', 'application/json')
		return response
	})

	await expect(provider.getToken(true)).rejects.toThrow()
})
