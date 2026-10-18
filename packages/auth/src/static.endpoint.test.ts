import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { AuthServiceDefinition, LoginResponseSchema, LoginResultSchema } from '@ydbjs/api/auth'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Server, type ServerOptions } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import { StaticCredentialsProvider } from './static.ts'

function loginServer(options?: ServerOptions) {
	let requests: Array<{ user: string; password: string }> = []
	let server = new Server(options)
	server.add(AuthServiceDefinition, {
		async login(request) {
			requests.push({ user: request.user, password: request.password })
			return create(LoginResponseSchema, {
				operation: {
					ready: true,
					status: StatusIds_StatusCode.SUCCESS,
					result: anyPack(
						LoginResultSchema,
						create(LoginResultSchema, { token: 'endpoint-token' })
					),
				},
			})
		},
	})
	return { server, requests }
}

test.for(['http', 'grpc'])('authenticates at the configured %s endpoint', async (protocol, tc) => {
	let { server, requests } = loginServer()
	using peer = server
	let port = await peer.listen('127.0.0.1:0')
	let provider = new StaticCredentialsProvider(
		{ username: 'test-user', password: 'test-password' },
		`${protocol}://127.0.0.1:${port}`
	)

	expect(await provider.getToken(true, tc.signal)).toBe('endpoint-token')
	expect(requests).toEqual([{ user: 'test-user', password: 'test-password' }])
})

test('authenticates through the configured Unix socket', async (tc) => {
	await using files = {
		path: await mkdtemp(join(tmpdir(), 'ydb-auth-socket-')),
		[Symbol.asyncDispose]() {
			return rm(this.path, { recursive: true, force: true })
		},
	}
	let { server, requests } = loginServer()
	using peer = server
	let endpoint = `unix://${join(files.path, 'auth.sock')}`
	await peer.listen(endpoint)
	let provider = new StaticCredentialsProvider(
		{ username: 'test-user', password: 'test-password' },
		endpoint
	)

	expect(await provider.getToken(true, tc.signal)).toBe('endpoint-token')
	expect(requests).toHaveLength(1)
})

test.for(['grpcs', 'grpc'])(
	'authenticates over TLS at a %s endpoint with explicit secure options',
	async (protocol, tc) => {
		await using files = {
			path: await mkdtemp(join(tmpdir(), 'ydb-auth-tls-')),
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
		let { server, requests } = loginServer({ tls: { key: await readFile(key), cert: ca } })
		using peer = server
		let port = await peer.listen('127.0.0.1:0')
		let provider = new StaticCredentialsProvider(
			{ username: 'test-user', password: 'test-password' },
			`${protocol}://127.0.0.1:${port}`,
			{ ca },
			{ tls: { servername: 'ydb.test' } }
		)

		expect(await provider.getToken(true, tc.signal)).toBe('endpoint-token')
		expect(requests).toHaveLength(1)
	}
)
