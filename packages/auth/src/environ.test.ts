import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, expect, test } from 'vitest'

import { EnvironCredentialsProvider, getSecureOptionsFromEnviron } from './environ.ts'

let savedEnv: NodeJS.ProcessEnv

let ydbEnvVars = [
	'YDB_ANONYMOUS_CREDENTIALS',
	'YDB_METADATA_CREDENTIALS',
	'YDB_METADATA_CREDENTIALS_ENDPOINT',
	'YDB_METADATA_CREDENTIALS_FLAVOR',
	'YDB_ACCESS_TOKEN_CREDENTIALS',
	'YDB_STATIC_CREDENTIALS_USER',
	'YDB_STATIC_CREDENTIALS_PASSWORD',
	'YDB_STATIC_CREDENTIALS_ENDPOINT',
	'YDB_SSL_ROOT_CERTIFICATES_FILE',
	'YDB_SSL_ROOT_CERTIFICATES',
	'YDB_SSL_CERTIFICATE_FILE',
	'YDB_SSL_CERTIFICATE',
	'YDB_SSL_PRIVATE_KEY_FILE',
	'YDB_SSL_PRIVATE_KEY',
	'NODE_EXTRA_CA_CERTS',
]

beforeEach(() => {
	savedEnv = { ...process.env }
	for (let key of ydbEnvVars) {
		delete process.env[key]
	}
})

afterEach(() => {
	process.env = savedEnv
})

function writeTmpFile(content: string): string {
	let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-auth-test-'))
	let filePath = path.join(tmpDir, 'test.pem')
	fs.writeFileSync(filePath, content)
	return filePath
}

// --- EnvironCredentialsProvider: credential detection ---

test('defaults to anonymous when no env vars set', async () => {
	let provider = new EnvironCredentialsProvider()
	let token = await provider.getToken()
	expect(token).eq('')
})

test('detects YDB_ANONYMOUS_CREDENTIALS=1', async () => {
	process.env.YDB_ANONYMOUS_CREDENTIALS = '1'
	let provider = new EnvironCredentialsProvider()
	let token = await provider.getToken()
	expect(token).eq('')
})

test('detects YDB_ACCESS_TOKEN_CREDENTIALS', async () => {
	process.env.YDB_ACCESS_TOKEN_CREDENTIALS = 'my-token-123'
	let provider = new EnvironCredentialsProvider()
	let token = await provider.getToken()
	expect(token).eq('my-token-123')
})

test('YDB_ANONYMOUS_CREDENTIALS takes priority over YDB_ACCESS_TOKEN_CREDENTIALS', async () => {
	process.env.YDB_ANONYMOUS_CREDENTIALS = '1'
	process.env.YDB_ACCESS_TOKEN_CREDENTIALS = 'my-token'
	let provider = new EnvironCredentialsProvider()
	let token = await provider.getToken()
	expect(token).eq('')
})

test('YDB_METADATA_CREDENTIALS takes priority over YDB_ACCESS_TOKEN_CREDENTIALS', () => {
	process.env.YDB_METADATA_CREDENTIALS = '1'
	process.env.YDB_ACCESS_TOKEN_CREDENTIALS = 'my-token'
	let provider = new EnvironCredentialsProvider()
	expect(provider).toBeInstanceOf(EnvironCredentialsProvider)
})

test('accepts YDB_METADATA_CREDENTIALS with custom endpoint and flavor', () => {
	process.env.YDB_METADATA_CREDENTIALS = '1'
	process.env.YDB_METADATA_CREDENTIALS_ENDPOINT = 'http://custom:8080/token'
	process.env.YDB_METADATA_CREDENTIALS_FLAVOR = 'Yandex'
	let provider = new EnvironCredentialsProvider()
	expect(provider).toBeInstanceOf(EnvironCredentialsProvider)
})

test('accepts YDB_STATIC_CREDENTIALS_USER with endpoint env var', () => {
	process.env.YDB_STATIC_CREDENTIALS_USER = 'admin'
	process.env.YDB_STATIC_CREDENTIALS_PASSWORD = 'secret'
	process.env.YDB_STATIC_CREDENTIALS_ENDPOINT = 'grpc://localhost:2136'
	let provider = new EnvironCredentialsProvider()
	expect(provider).toBeInstanceOf(EnvironCredentialsProvider)
})

test('derives static credentials endpoint from connection string', () => {
	process.env.YDB_STATIC_CREDENTIALS_USER = 'admin'
	process.env.YDB_STATIC_CREDENTIALS_PASSWORD = 'secret'
	let provider = new EnvironCredentialsProvider('grpc://localhost:2136/local')
	expect(provider).toBeInstanceOf(EnvironCredentialsProvider)
})

test('throws when YDB_STATIC_CREDENTIALS_USER set without endpoint or connection string', () => {
	process.env.YDB_STATIC_CREDENTIALS_USER = 'admin'
	expect(() => new EnvironCredentialsProvider()).toThrow(
		/YDB_STATIC_CREDENTIALS_ENDPOINT is not set/
	)
})

test('defaults YDB_STATIC_CREDENTIALS_PASSWORD to empty string', () => {
	process.env.YDB_STATIC_CREDENTIALS_USER = 'admin'
	process.env.YDB_STATIC_CREDENTIALS_ENDPOINT = 'grpc://localhost:2136'
	let provider = new EnvironCredentialsProvider()
	expect(provider).toBeInstanceOf(EnvironCredentialsProvider)
})

// --- getSecureOptionsFromEnviron ---

test('returns undefined when no TLS env vars set', () => {
	expect(getSecureOptionsFromEnviron()).toBeUndefined()
})

test('reads CA from YDB_SSL_ROOT_CERTIFICATES_FILE', () => {
	process.env.YDB_SSL_ROOT_CERTIFICATES_FILE = writeTmpFile('ca-from-file')
	let opts = getSecureOptionsFromEnviron()
	expect(Buffer.from(opts!.ca as Buffer).toString()).eq('ca-from-file')
})

test('reads CA from NODE_EXTRA_CA_CERTS', () => {
	process.env.NODE_EXTRA_CA_CERTS = writeTmpFile('ca-node')
	let opts = getSecureOptionsFromEnviron()
	expect(Buffer.from(opts!.ca as Buffer).toString()).eq('ca-node')
})

test('reads cert from YDB_SSL_CERTIFICATE_FILE', () => {
	process.env.YDB_SSL_CERTIFICATE_FILE = writeTmpFile('cert-from-file')
	let opts = getSecureOptionsFromEnviron()
	expect(Buffer.from(opts!.cert as Buffer).toString()).eq('cert-from-file')
})

test('reads key from YDB_SSL_PRIVATE_KEY_FILE', () => {
	process.env.YDB_SSL_PRIVATE_KEY_FILE = writeTmpFile('key-from-file')
	let opts = getSecureOptionsFromEnviron()
	expect(Buffer.from(opts!.key as Buffer).toString()).eq('key-from-file')
})

test('reads CA from YDB_SSL_ROOT_CERTIFICATES string', () => {
	process.env.YDB_SSL_ROOT_CERTIFICATES =
		'-----BEGIN CERTIFICATE-----\nca-inline\n-----END CERTIFICATE-----'
	let opts = getSecureOptionsFromEnviron()
	expect(opts!.ca).eq('-----BEGIN CERTIFICATE-----\nca-inline\n-----END CERTIFICATE-----')
})

test('reads cert from YDB_SSL_CERTIFICATE string', () => {
	process.env.YDB_SSL_CERTIFICATE =
		'-----BEGIN CERTIFICATE-----\ncert-inline\n-----END CERTIFICATE-----'
	let opts = getSecureOptionsFromEnviron()
	expect(opts!.cert).eq('-----BEGIN CERTIFICATE-----\ncert-inline\n-----END CERTIFICATE-----')
})

test('reads key from YDB_SSL_PRIVATE_KEY string', () => {
	process.env.YDB_SSL_PRIVATE_KEY =
		'-----BEGIN PRIVATE KEY-----\nkey-inline\n-----END PRIVATE KEY-----'
	let opts = getSecureOptionsFromEnviron()
	expect(opts!.key).eq('-----BEGIN PRIVATE KEY-----\nkey-inline\n-----END PRIVATE KEY-----')
})

test('throws when both YDB_SSL_ROOT_CERTIFICATES_FILE and YDB_SSL_ROOT_CERTIFICATES are set', () => {
	process.env.YDB_SSL_ROOT_CERTIFICATES_FILE = writeTmpFile('from-file')
	process.env.YDB_SSL_ROOT_CERTIFICATES = 'from-string'
	expect(() => getSecureOptionsFromEnviron()).toThrow(/Ambiguous CA configuration/)
})

test('throws when both NODE_EXTRA_CA_CERTS and YDB_SSL_ROOT_CERTIFICATES are set', () => {
	process.env.NODE_EXTRA_CA_CERTS = writeTmpFile('from-file')
	process.env.YDB_SSL_ROOT_CERTIFICATES = 'from-string'
	expect(() => getSecureOptionsFromEnviron()).toThrow(/Ambiguous CA configuration/)
})

test('throws when both YDB_SSL_CERTIFICATE_FILE and YDB_SSL_CERTIFICATE are set', () => {
	process.env.YDB_SSL_CERTIFICATE_FILE = writeTmpFile('from-file')
	process.env.YDB_SSL_CERTIFICATE = 'from-string'
	expect(() => getSecureOptionsFromEnviron()).toThrow(
		/Ambiguous client certificate configuration/
	)
})

test('throws when both YDB_SSL_PRIVATE_KEY_FILE and YDB_SSL_PRIVATE_KEY are set', () => {
	process.env.YDB_SSL_PRIVATE_KEY_FILE = writeTmpFile('from-file')
	process.env.YDB_SSL_PRIVATE_KEY = 'from-string'
	expect(() => getSecureOptionsFromEnviron()).toThrow(/Ambiguous private key configuration/)
})

test('reads all three from files', () => {
	process.env.YDB_SSL_ROOT_CERTIFICATES_FILE = writeTmpFile('ca')
	process.env.YDB_SSL_CERTIFICATE_FILE = writeTmpFile('cert')
	process.env.YDB_SSL_PRIVATE_KEY_FILE = writeTmpFile('key')
	let opts = getSecureOptionsFromEnviron()
	expect(Buffer.from(opts!.ca as Buffer).toString()).eq('ca')
	expect(Buffer.from(opts!.cert as Buffer).toString()).eq('cert')
	expect(Buffer.from(opts!.key as Buffer).toString()).eq('key')
})

test('reads all three from strings', () => {
	process.env.YDB_SSL_ROOT_CERTIFICATES = 'ca-str'
	process.env.YDB_SSL_CERTIFICATE = 'cert-str'
	process.env.YDB_SSL_PRIVATE_KEY = 'key-str'
	let opts = getSecureOptionsFromEnviron()
	expect(opts!.ca).eq('ca-str')
	expect(opts!.cert).eq('cert-str')
	expect(opts!.key).eq('key-str')
})

// --- EnvironCredentialsProvider.secureOptions ---

test('exposes undefined secureOptions when no TLS env vars', () => {
	let provider = new EnvironCredentialsProvider()
	expect(provider.secureOptions).toBeUndefined()
})

test('exposes secureOptions populated from TLS env string', () => {
	process.env.YDB_SSL_ROOT_CERTIFICATES = 'ca-inline'
	let provider = new EnvironCredentialsProvider()
	expect(provider.secureOptions).toBeDefined()
	expect(provider.secureOptions!.ca).eq('ca-inline')
})
