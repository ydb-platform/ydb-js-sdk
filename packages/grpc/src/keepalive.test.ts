import { setImmediate, setTimeout } from 'node:timers/promises'

import { expect, test } from 'vitest'

import { nodePeer } from '../tests/node-peer.ts'
import { Client } from './client.ts'

async function waitForRetiredConnection(client: Client, signal: AbortSignal): Promise<void> {
	while (client.state !== 'idle') {
		// oxlint-disable-next-line no-await-in-loop
		await setImmediate(undefined, { signal })
	}
}

// A peer can reject frequent pings without rejecting an RPC; the next connection must retain that feedback.
test('increases the next connection ping interval after too_many_pings GOAWAY', async (tc) => {
	await using peer = await nodePeer({ type: 'keepalive' }, tc.signal)
	let options = { keepaliveIntervalMs: 40, keepaliveTimeoutMs: 1000 }
	using client = new Client(peer.authority, options)
	await client.connect(tc.signal)
	await peer.wait('goaway-sent')
	await waitForRetiredConnection(client, tc.signal)
	await peer.wait('session-closed-1')
	let started = performance.now()

	await client.connect(tc.signal)
	let pingDelay = await peer.wait('ping-2')

	expect(performance.now() - started).toBeGreaterThanOrEqual(60)
	expect(pingDelay).toBeGreaterThanOrEqual(60)
	expect((await peer.snapshot()).sessions).toBe(2)
	expect(options.keepaliveIntervalMs).toBe(40)
})

test('caps ping backoff before a Node timer can overflow to one millisecond', async (tc) => {
	await using peer = await nodePeer({ type: 'keepalive-cap' }, tc.signal)
	using client = new Client(peer.authority, { keepaliveIntervalMs: 1_500_000_000 })
	await client.connect(tc.signal)
	await peer.wait('session-1')
	await peer.command('send-goaway')
	await waitForRetiredConnection(client, tc.signal)
	await peer.wait('session-closed-1')

	await client.connect(tc.signal)
	await setTimeout(50, undefined, { signal: tc.signal })

	let state = await peer.snapshot()
	expect(state.pings).toBe(0)
	expect(state.sessions).toBe(2)
})
