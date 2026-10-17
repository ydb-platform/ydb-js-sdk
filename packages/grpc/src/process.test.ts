import { execFile } from 'node:child_process'
import { type AddressInfo, createServer } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

import { rawServer, reply } from '../tests/fixtures.ts'

// A child process exposes socket ref/unref behavior that a running test worker would hide.
async function runClient(authority: string, body: string, signal: AbortSignal) {
	let entry = new URL('../dist/index.js', import.meta.url).href
	let source = `
import { Client } from ${JSON.stringify(entry)}
let authority = ${JSON.stringify(authority)}
let client = new Client(authority, { keepaliveIntervalMs: 10, keepaliveTimeoutMs: 1000 })
let method = {
	path: '/test.Transport/Unary',
	requestStream: false,
	responseStream: false,
	requestSerialize: value => Buffer.from(value),
	responseDeserialize: bytes => Buffer.from(bytes).toString(),
}
${body}
`
	return promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source], {
		signal,
		timeout: 2000,
		killSignal: 'SIGKILL',
	})
}

test('exits naturally after connecting without calls despite idle keepalive', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['unexpected']))

	let { stdout } = await runClient(
		peer.authority,
		`
await client.connect()
console.log('connected')
`,
		tc.signal
	)

	expect(stdout.trim()).toBe('connected')
	expect(peer.streams).toHaveLength(0)
})

test('exits naturally after a successful call without explicitly closing the client', async (tc) => {
	await using peer = await rawServer((stream) => reply(stream, ['complete']))

	let { stdout } = await runClient(
		peer.authority,
		`
for await (let value of client.call(method, 'request')) {
	console.log(value)
}
`,
		tc.signal
	)

	expect(stdout.trim()).toBe('complete')
})

test('keeps the process alive while a call waits for its response', async (tc) => {
	await using peer = await rawServer(async (stream) => {
		await setTimeout(100, undefined, { signal: tc.signal })
		reply(stream, ['delayed response'])
	})

	let { stdout } = await runClient(
		peer.authority,
		`
for await (let value of client.call(method, 'request')) {
	console.log(value)
}
`,
		tc.signal
	)

	expect(stdout.trim()).toBe('delayed response')
})

test('keeps the process alive until an unanswered call reaches its deadline', async (tc) => {
	await using peer = await rawServer((stream) => {
		stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
	})

	let { stdout } = await runClient(
		peer.authority,
		`
try {
	for await (let value of client.call(method, 'request', { deadline: Date.now() + 100 })) {
		console.log(value)
	}
} catch (error) {
	console.log(error.code)
}
`,
		tc.signal
	)

	expect(stdout.trim()).toBe('4')
})

test('exits naturally after the only call is cancelled during HTTP/2 setup', async (tc) => {
	await using peer = createServer((socket) => socket.resume())
	await new Promise<void>((resolve, reject) => {
		peer.once('error', reject)
		peer.listen(0, '127.0.0.1', resolve)
	})
	let { port } = peer.address() as AddressInfo

	let { stdout } = await runClient(
		`http://127.0.0.1:${port}`,
		`
let controller = new AbortController()
setTimeout(() => controller.abort(new Error('cancelled')), 50).unref()
try {
	for await (let value of client.call(method, 'request', { signal: controller.signal })) {
		console.log(value)
	}
} catch (error) {
	console.log(error.message)
}
`,
		tc.signal
	)

	expect(stdout.trim()).toBe('cancelled')
})

test('keeps another connection waiter alive when one caller cancels', async (tc) => {
	await using peer = createServer((socket) => socket.resume())
	await new Promise<void>((resolve, reject) => {
		peer.once('error', reject)
		peer.listen(0, '127.0.0.1', resolve)
	})
	let { port } = peer.address() as AddressInfo

	let { stdout } = await runClient(
		`http://127.0.0.1:${port}`,
		`
let shared = new Client(authority, { connectTimeoutMs: 120 })
let controller = new AbortController()
let first = shared.connect(controller.signal).catch(error => error.message)
let second = shared.connect().catch(error => error.code)
setTimeout(() => controller.abort(new Error('first cancelled')), 30).unref()
console.log(await first)
console.log(await second)
`,
		tc.signal
	)

	expect(stdout.trim()).toBe('first cancelled\n14')
})
