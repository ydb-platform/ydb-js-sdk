import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Server, ServerCredentials, type ServerUnaryCall, type sendUnaryData } from '@grpc/grpc-js'
import { expect, test } from 'vitest'

import { runMemoryProfile } from '../tests/memory-profile.ts'

let execute = promisify(execFile)
let grpcPath = createRequire(import.meta.url).resolve('@grpc/grpc-js')
let method = {
	path: '/memory.Proxy/Probe',
	requestStream: false,
	responseStream: false,
	requestSerialize: (value: string) => Buffer.from(value),
	requestDeserialize: (value: Buffer) => value.toString(),
	responseSerialize: (value: string) => Buffer.from(value),
	responseDeserialize: (value: Buffer) => value.toString(),
}

// Certificate failures need a local server with a deliberately invalid identity.
async function proxyFixture(signal: AbortSignal, certificateName?: string, trusted = true) {
	let directory = await mkdtemp(join(tmpdir(), 'topic-memory-proxy-'))
	let server = new Server()
	let environment = new Map(
		['GRPC_DEFAULT_SSL_ROOTS_FILE_PATH', 'no_grpc_proxy', 'no_proxy'].map((key) => [
			key,
			process.env[key],
		])
	)
	let dispose = async () => {
		server.forceShutdown()
		for (let [key, value] of environment) {
			if (value === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = value
			}
		}
		await rm(directory, { recursive: true, force: true })
	}
	try {
		let credentials = ServerCredentials.createInsecure()
		delete process.env['GRPC_DEFAULT_SSL_ROOTS_FILE_PATH']
		if (certificateName) {
			let key = join(directory, 'key.pem')
			let cert = join(directory, 'cert.pem')
			await execute(
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
					cert,
					'-subj',
					`/CN=${certificateName}`,
					'-addext',
					`subjectAltName=DNS:${certificateName}`,
					'-days',
					'1',
				],
				{ signal }
			)
			credentials = ServerCredentials.createSsl(null, [
				{ private_key: await readFile(key), cert_chain: await readFile(cert) },
			])
			if (trusted) {
				process.env['GRPC_DEFAULT_SSL_ROOTS_FILE_PATH'] = cert
			}
		}
		process.env['no_grpc_proxy'] = 'localhost'
		process.env['no_proxy'] = 'localhost'
		let calls = 0
		server.addService(
			{ probe: method },
			{
				probe(call: ServerUnaryCall<string, string>, callback: sendUnaryData<string>) {
					calls++
					callback(null, call.getPeer())
				},
			}
		)
		let port = await new Promise<number>((resolve, reject) => {
			server.bindAsync('localhost:0', credentials, (error, boundPort) => {
				if (error) {
					reject(error)
				} else {
					resolve(boundPort)
				}
			})
		})
		let worker = join(directory, 'worker.cjs')
		await writeFile(
			worker,
			`let assert = require('node:assert/strict')
let { once } = require('node:events')
let { writeFileSync } = require('node:fs')
let grpc = require(${JSON.stringify(grpcPath)})
process.channel.ref()
let url = new URL(process.env.YDB_CONNECTION_STRING)
let Client = grpc.makeGenericClientConstructor({ probe: {
	path: '/memory.Proxy/Probe', requestStream: false, responseStream: false,
	requestSerialize: value => Buffer.from(value), responseDeserialize: value => value.toString(),
} })
let client = new Client(url.host, url.protocol === 'grpcs:' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure())
let probe = () => new Promise((resolve, reject) => client.probe('ping', (error, reply) => error ? reject(error) : resolve(reply)))
async function run() {
	try {
		let first = await probe()
		let disconnected = once(process, 'message')
		process.send({ type: 'disconnect' })
		await disconnected
		let channel = client.getChannel()
		if (channel.getConnectivityState(false) === grpc.connectivityState.READY) {
			await new Promise((resolve, reject) => channel.watchConnectivityState(grpc.connectivityState.READY, Infinity, error => error ? reject(error) : resolve()))
		}
		await new Promise((resolve, reject) => client.waitForReady(Infinity, error => error ? reject(error) : resolve()))
		let second = await probe()
		assert.notEqual(first, second, 'Disconnect did not replace the upstream TCP connection')
		writeFileSync(process.env.MEMORY_REPORT_FILE, JSON.stringify({ node: process.version }))
	} finally {
		client.close()
		process.disconnect()
	}
}
run().catch(error => { console.error(error); process.exitCode = 1 })
`
		)
		return {
			connectionString: `${certificateName ? 'grpcs' : 'grpc'}://localhost:${port}/local`,
			worker,
			report: join(directory, 'report.json'),
			get calls() {
				return calls
			},
			[Symbol.asyncDispose]: dispose,
		}
	} catch (error) {
		await dispose()
		throw error
	}
}

test('cuts plaintext memory worker connections despite inherited proxy exclusions', async (tc) => {
	await using fixture = await proxyFixture(tc.signal)
	let result = await runMemoryProfile(
		fixture.connectionString,
		fixture.worker,
		fixture.report,
		tc.signal
	)
	expect(result.cuts).toBe(1)
	expect(fixture.calls).toBe(2)
})

test('preserves TLS server identity when cutting memory worker connections', async (tc) => {
	await using fixture = await proxyFixture(tc.signal, 'localhost')
	let result = await runMemoryProfile(
		fixture.connectionString,
		fixture.worker,
		fixture.report,
		tc.signal
	)
	expect(result.cuts).toBe(1)
	expect(fixture.calls).toBe(2)
})

test('rejects a trusted certificate for the wrong memory upstream hostname', async (tc) => {
	await using fixture = await proxyFixture(tc.signal, 'wrong.example')
	await expect(
		runMemoryProfile(fixture.connectionString, fixture.worker, fixture.report, tc.signal)
	).rejects.toThrow(/Hostname\/IP does not match certificate/)
	expect(fixture.calls).toBe(0)
})

test('rejects an untrusted memory upstream certificate', async (tc) => {
	await using fixture = await proxyFixture(tc.signal, 'localhost', false)
	await expect(
		runMemoryProfile(fixture.connectionString, fixture.worker, fixture.report, tc.signal)
	).rejects.toThrow(/self-signed certificate/)
	expect(fixture.calls).toBe(0)
})
