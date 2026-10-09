import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { ServerCredentials } from '@grpc/grpc-js'
import { createServer } from 'nice-grpc'
import { expect, test } from 'vitest'

import { Driver } from './driver.ts'

test('uses the configured TLS identity when the endpoint has no override', async (tc) => {
	// A private test CA and a mismatched dial hostname isolate TLS identity from cluster configuration.
	await using files = {
		path: await mkdtemp(join(tmpdir(), 'ydb-driver-tls-')),
		[Symbol.asyncDispose]() {
			return rm(this.path, { recursive: true, force: true })
		},
	}
	let key = join(files.path, 'key.pem')
	let certificate = join(files.path, 'cert.pem')
	await promisify(execFile)(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			key,
			'-out',
			certificate,
			'-subj',
			'/CN=ydb.test',
			'-addext',
			'subjectAltName=DNS:ydb.test',
			'-days',
			'1',
		],
		{ signal: tc.signal }
	)
	let ca = await readFile(certificate)
	await using fixture = {
		server: createServer(),
		[Symbol.asyncDispose]() {
			return this.server.shutdown()
		},
	}
	let server = fixture.server
	let service = { whoAmI: DiscoveryServiceDefinition.whoAmI }
	server.add(service, {
		async whoAmI() {
			return {}
		},
	})
	let port = await server.listen(
		'127.0.0.1:0',
		ServerCredentials.createSsl(null, [{ private_key: await readFile(key), cert_chain: ca }])
	)
	using driver = new Driver(`grpcs://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
		secureOptions: { ca },
		channelOptions: { 'grpc.ssl_target_name_override': 'ydb.test' },
	})
	await expect(
		driver.createClient(service).whoAmI({}, { signal: tc.signal })
	).resolves.toBeDefined()
})
