import { spawn } from 'node:child_process'
import { once } from 'node:events'

import { expect, test } from 'vitest'

import { service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { Status } from './error.ts'

// A Node peer emits real resets even when the client runtime is Bun 1.4.3.
async function drainingPeer(signal: AbortSignal) {
	let peerProcess = spawn(
		'node',
		[
			'--max-old-space-size=64',
			'--eval',
			`
		let { createServer, constants } = require('node:http2')
		let server = createServer()
		let session
		let socket
		let streams = []
		function frame(text) {
			let body = Buffer.from(text)
			let header = Buffer.alloc(5)
			header.writeUInt32BE(body.length, 1)
			return Buffer.concat([header, body])
		}
		server.on('connection', connection => { socket = connection })
		server.on('session', connection => {
			session = connection
			session.on('error', () => {})
		})
		server.on('stream', stream => {
			streams.push(stream)
			stream.on('error', () => {})
			stream.resume()
			stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
			stream.write(frame('accepted'))
		})
		process.on('message', command => {
			if (command === 'goaway') {
				session.goaway(constants.NGHTTP2_NO_ERROR, streams.at(-1).id)
				session.ping(error => process.send(error ? { error: error.message } : 'draining'))
			} else if (command === 'cancel') {
				streams[0].close(constants.NGHTTP2_CANCEL)
				process.send({ destroyed: session.destroyed, socketDestroyed: socket.destroyed, calls: streams.length })
			} else if (command === 'disconnect') {
				socket.destroy()
				process.send('disconnected')
			} else if (command === 'finish') {
				streams[1].end(frame('survived'))
			}
		})
		server.listen(0, '127.0.0.1', () => process.send(server.address().port))
	`,
		],
		{ stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
	)
	try {
		let [port] = await once(peerProcess, 'message', { signal })
		return {
			authority: `http://127.0.0.1:${port}`,
			async command(command: 'goaway' | 'cancel' | 'disconnect') {
				let response = once(peerProcess, 'message', { signal })
				peerProcess.send(command)
				return (await response)[0]
			},
			finish() {
				peerProcess.send('finish')
			},
			async [Symbol.asyncDispose]() {
				if (peerProcess.exitCode !== null || peerProcess.signalCode !== null) return
				let exited = once(peerProcess, 'exit')
				peerProcess.kill()
				await exited
			},
		}
	} catch (error) {
		peerProcess.kill()
		throw error
	}
}

test.for(['peer cancel after GOAWAY', 'socket loss', 'socket loss after GOAWAY'] as const)(
	'distinguishes %s while another accepted RPC remains active',
	async (scenario, tc) => {
		await using peer = await drainingPeer(tc.signal)
		using client = new Client(peer.authority)
		let firstStatuses: number[] = []
		let secondStatuses: number[] = []
		let first = client.call(service.serverStream, '', {
			signal: tc.signal,
			onStatus: (status) => firstStatuses.push(status.code),
		})
		expect((await first.next()).value).toBe('accepted')
		let second = client.call(service.serverStream, '', {
			signal: tc.signal,
			onStatus: (status) => secondStatuses.push(status.code),
		})
		expect((await second.next()).value).toBe('accepted')
		let goaway = scenario !== 'socket loss'
		let acknowledgement = goaway ? await peer.command('goaway') : undefined
		expect(acknowledgement).toBe(goaway ? 'draining' : undefined)
		expect(client.state).toBe(goaway ? 'idle' : 'ready')
		let failure = first.next().catch((error: unknown) => error)
		let sibling = second.next().then(
			(part) => ({ value: part.value, done: part.done }),
			(error: unknown) => ({ code: (error as { code: number }).code })
		)
		let cancelled = scenario === 'peer cancel after GOAWAY'
		let state = await peer.command(cancelled ? 'cancel' : 'disconnect')
		let failed = await failure
		if (cancelled) peer.finish()
		let next = await sibling
		expect(failed).toMatchObject({ code: cancelled ? Status.CANCELLED : Status.UNAVAILABLE })
		expect(firstStatuses).toEqual([cancelled ? Status.CANCELLED : Status.UNAVAILABLE])
		expect(state).toEqual(
			cancelled ? { destroyed: false, socketDestroyed: false, calls: 2 } : 'disconnected'
		)
		expect(next).toEqual(
			cancelled ? { value: 'survived', done: false } : { code: Status.UNAVAILABLE }
		)
		expect((await second.next()).done).toBe(true)
		expect(secondStatuses).toEqual([cancelled ? Status.OK : Status.UNAVAILABLE])
	}
)
