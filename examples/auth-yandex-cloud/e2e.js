import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('exchanges a service account JWT and queries YDB', async (t) => {
	let dir = await mkdtemp(join(tmpdir(), 'ydb-iam-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	let keyPath = join(dir, 'authorized_key.json')
	let { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
	let key = {
		id: 'example-key',
		service_account_id: 'example-account',
		private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
	}
	await writeFile(keyPath, JSON.stringify(key), { mode: 0o600 })
	let exchange = t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(url, 'https://iam.api.cloud.yandex.net/iam/v1/tokens')
		assert.equal(options.method, 'POST')
		assert.ok(JSON.parse(options.body).jwt)
		return Response.json({
			iamToken: 'example@builtin',
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		})
	})
	process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS = keyPath
	process.env.YDB_CONNECTION_STRING ??= 'grpc://localhost:2136/local'
	await import('./index.js')
	assert.equal(exchange.mock.callCount(), 1)
})
