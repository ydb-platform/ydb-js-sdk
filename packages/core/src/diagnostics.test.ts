import { expect, test } from 'vitest'
import { channel as dcChannel } from 'node:diagnostics_channel'
import { credentials } from '@grpc/grpc-js'

import { ConnectionPool, POOL_GET_ACTIVE_FOR_TESTING } from './pool.js'

function makeProtoEndpoint(nodeId: number, port = 2136) {
	return {
		nodeId,
		address: `node-${nodeId}`,
		port,
		location: 'dc1',
		sslTargetNameOverride: '',
	} as any
}

function makePool() {
	return new ConnectionPool({
		channelCredentials: credentials.createInsecure(),
		idleTimeout: 0,
		idleInterval: 0,
		pessimizationTimeout: 60_000,
	})
}

/** Subscribe to a plain channel and collect published payloads. */
function collect(name: string) {
	let payloads: unknown[] = []
	let fn = (msg: unknown) => payloads.push(structuredClone(msg))
	dcChannel(name).subscribe(fn)
	return { payloads, stop: () => dcChannel(name).unsubscribe(fn) }
}

test('ydb:pool.connection.added — fires with nodeId, address, location when endpoint is synced in', () => {
	let pool = makePool()
	let { payloads, stop } = collect('ydb:pool.connection.added')
	try {
		pool.sync([makeProtoEndpoint(1)])

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toMatchObject({
			nodeId: 1n,
			address: 'node-1:2136',
			location: 'dc1',
		})
	} finally {
		stop()
		pool.close()
	}
})

test('ydb:pool.connection.removed — fires when a previously active endpoint disappears from discovery', () => {
	let pool = makePool()
	pool.sync([makeProtoEndpoint(1)])

	let { payloads, stop } = collect('ydb:pool.connection.removed')
	try {
		pool.sync([]) // node 1 is no longer in discovery

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toMatchObject({
			nodeId: 1n,
			reason: 'discovery.stale_active',
		})
	} finally {
		stop()
		pool.close()
	}
})

test('ydb:pool.pessimize — fires with nodeId and address when a connection is pessimized', () => {
	let pool = makePool()
	pool.sync([makeProtoEndpoint(2)])
	let [conn] = pool[POOL_GET_ACTIVE_FOR_TESTING]()

	let { payloads, stop } = collect('ydb:pool.pessimize')
	try {
		pool.pessimize(conn!)

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toMatchObject({
			nodeId: 2n,
			address: 'node-2:2136',
		})
	} finally {
		stop()
		pool.close()
	}
})

test('ydb:pool.connection.removed — fires for a pessimized endpoint removed by discovery', () => {
	let pool = makePool()
	pool.sync([makeProtoEndpoint(3)])
	let [conn] = pool[POOL_GET_ACTIVE_FOR_TESTING]()
	pool.pessimize(conn!) // move node 3 to pessimized map

	let { payloads, stop } = collect('ydb:pool.connection.removed')
	try {
		pool.sync([]) // node 3 is pessimized and now stale

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toMatchObject({
			nodeId: 3n,
			reason: 'discovery.stale_pessimized',
		})
	} finally {
		stop()
		pool.close()
	}
})
