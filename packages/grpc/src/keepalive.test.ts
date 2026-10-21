import { constants } from 'node:http2'
import { setImmediate, setTimeout } from 'node:timers/promises'

import { abortable } from '@ydbjs/abortable'
import { expect, test } from 'vitest'

import { deferred, rawServer } from '../tests/fixtures.ts'
import { Client } from './client.ts'

async function waitForRetiredConnection(client: Client, signal: AbortSignal): Promise<void> {
	while (client.state !== 'idle') {
		// oxlint-disable-next-line no-await-in-loop
		await setImmediate(undefined, { signal })
	}
}

// A peer can reject frequent pings without rejecting an RPC; the next connection must retain that feedback.
test('increases the next connection ping interval after too_many_pings GOAWAY', async (tc) => {
	let goaway = deferred()
	let firstClosed = deferred()
	let nextPing = deferred<number>()
	await using peer = await rawServer(() => {})
	peer.server.on('session', (session) => {
		let number = peer.sessions.length
		let started = performance.now()
		if (number === 1) session.once('close', () => firstClosed.resolve())
		session.once('ping', () => {
			if (number === 1) {
				session.goaway(
					constants.NGHTTP2_ENHANCE_YOUR_CALM,
					0,
					Buffer.from('too_many_pings')
				)
				session.close()
				goaway.resolve()
			} else {
				nextPing.resolve(performance.now() - started)
			}
		})
	})
	let options = { keepaliveIntervalMs: 40, keepaliveTimeoutMs: 1000 }
	using client = new Client(peer.authority, options)
	await client.connect(tc.signal)
	await abortable(tc.signal, goaway.promise)
	await waitForRetiredConnection(client, tc.signal)
	await abortable(tc.signal, firstClosed.promise)
	let started = performance.now()

	await client.connect(tc.signal)
	let pingDelay = await abortable(tc.signal, nextPing.promise)

	expect(performance.now() - started).toBeGreaterThanOrEqual(60)
	expect(pingDelay).toBeGreaterThanOrEqual(60)
	expect(peer.sessions).toHaveLength(2)
	expect(options.keepaliveIntervalMs).toBe(40)
})

test('caps ping backoff before a Node timer can overflow to one millisecond', async (tc) => {
	let firstConnected = deferred()
	let firstClosed = deferred()
	let pings = 0
	await using peer = await rawServer(() => {})
	peer.server.on('session', (session) => {
		session.on('ping', () => pings++)
		if (peer.sessions.length === 1) {
			session.once('close', () => firstClosed.resolve())
			firstConnected.resolve()
		}
	})
	using client = new Client(peer.authority, { keepaliveIntervalMs: 1_500_000_000 })
	await client.connect(tc.signal)
	await abortable(tc.signal, firstConnected.promise)
	let first = peer.sessions[0]!
	first.goaway(constants.NGHTTP2_ENHANCE_YOUR_CALM, 0, Buffer.from('too_many_pings'))
	first.close()
	await waitForRetiredConnection(client, tc.signal)
	await abortable(tc.signal, firstClosed.promise)

	await client.connect(tc.signal)
	await setTimeout(50, undefined, { signal: tc.signal })

	expect(pings).toBe(0)
	expect(peer.sessions).toHaveLength(2)
})
