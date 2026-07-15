// Test scaffolding for the endpoints engine: a programmable fake discovery, a
// drivable fake connection factory, server-field builders, a microtask settler,
// a diagnostics capturer, and a convenience wiring. Mirrors reader.fixtures.ts.

import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { connectivityState, credentials } from '@grpc/grpc-js'

import type { Connection } from '../conn.js'
import type { DriverIdentity } from '../driver-identity.js'
import type { DriverHooks, EndpointInfo } from '../hooks.js'
import {
	type DiscoveryResult,
	type EndpointsRuntime,
	type ListEndpoints,
	createEndpointsRuntime,
} from './endpoints-runtime.js'
import type { DiscoveredEndpoint, PileState, PileStatus } from './endpoints-state.js'
import type { EndpointRef } from './snapshot.js'

export const TEST_IDENTITY: DriverIdentity = Object.freeze({
	database: '/local',
	address: 'localhost',
	port: 2136,
})

// ── Server-field builders ───────────────────────────────────────────────────

export let endpoint = function endpoint(
	nodeId: number,
	over: Partial<DiscoveredEndpoint> = {}
): DiscoveredEndpoint {
	return {
		nodeId: BigInt(nodeId),
		host: `node-${nodeId}`,
		port: 2136,
		location: 'A',
		loadFactor: 0,
		sslTargetNameOverride: '',
		ipV4: [],
		ipV6: [],
		bridgePileName: '',
		services: [],
		...over,
	}
}

export let pile = function pile(pileName: string, status: PileStatus): PileState {
	return { pileName, status }
}

export let discoveryResult = function discoveryResult(
	endpoints: DiscoveredEndpoint[],
	over: Partial<DiscoveryResult> = {}
): DiscoveryResult {
	return { endpoints, selfLocation: 'A', pileStates: [], ...over }
}

// ── Fake discovery ──────────────────────────────────────────────────────────

export type FakeDiscovery = {
	listEndpoints: ListEndpoints
	push: (result: DiscoveryResult) => void
	fail: (error: unknown) => void
	/** Make the next round hang until its signal aborts (a genuinely in-flight round). */
	hang: () => void
	callCount: () => number
	/** The AbortSignal handed to the most recent round (observe cancellation). */
	lastSignal: () => AbortSignal | undefined
	waitForRound: (n?: number) => Promise<void>
}

export let makeFakeDiscovery = function makeFakeDiscovery(): FakeDiscovery {
	let queue: Array<DiscoveryResult | { throw: unknown } | { hang: true }> = []
	let calls = 0
	let waiters: Array<{ at: number; resolve: () => void }> = []
	let lastSignal: AbortSignal | undefined

	let listEndpoints: ListEndpoints = async (signal) => {
		lastSignal = signal
		let i = calls
		calls++
		for (let w of waiters.splice(0)) {
			if (calls >= w.at) w.resolve()
			else waiters.push(w)
		}
		// Advance through pushed results by call index, repeating the last.
		if (queue.length === 0) return { endpoints: [], selfLocation: '', pileStates: [] }
		let next = queue[Math.min(i, queue.length - 1)]!
		if ('hang' in next) {
			await new Promise<never>((_resolve, reject) => {
				if (signal.aborted) reject(signal.reason)
				else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
			throw signal.reason // unreachable: the promise above always rejects first
		}
		if ('throw' in next) throw next.throw
		return next
	}

	return {
		listEndpoints,
		push: (result) => queue.push(result),
		fail: (error) => queue.push({ throw: error }),
		hang: () => queue.push({ hang: true }),
		callCount: () => calls,
		lastSignal: () => lastSignal,
		waitForRound: (n = 1) =>
			new Promise<void>((resolve) => {
				if (calls >= n) resolve()
				else waiters.push({ at: n, resolve })
			}),
	}
}

// ── Fake connection factory ─────────────────────────────────────────────────

export type FakeConnection = Connection & {
	closed: boolean
	driveState: (state: connectivityState) => void
}

export type FakeConnectionFactory = {
	factory: (ref: EndpointRef) => Connection
	materialized: FakeConnection[]
	byNode: (nodeId: bigint) => FakeConnection | undefined
	factoryCalls: () => number
}

export let makeFakeConnectionFactory = function makeFakeConnectionFactory(): FakeConnectionFactory {
	let materialized: FakeConnection[] = []

	let factory = function factory(ref: EndpointRef): Connection {
		let state = connectivityState.IDLE
		let endpointInfo: EndpointInfo = Object.freeze({
			nodeId: ref.nodeId,
			address: ref.address,
			location: ref.location,
			pile: ref.pile,
		})
		let channel = {
			getConnectivityState: (_tryToConnect: boolean) => state,
			close: () => {},
		} as unknown as Connection['channel']

		let conn: FakeConnection = {
			endpoint: endpointInfo,
			channel,
			closed: false,
			driveState: (next) => {
				state = next
			},
			close() {
				this.closed = true
			},
			[Symbol.dispose]() {
				this.close()
			},
		}
		materialized.push(conn)
		return conn
	}

	return {
		factory,
		materialized,
		byNode: (nodeId) => materialized.find((c) => c.endpoint.nodeId === nodeId),
		factoryCalls: () => materialized.length,
	}
}

// ── Determinism + diagnostics capture ───────────────────────────────────────

export let settle = async function settle(ticks = 50): Promise<void> {
	// oxlint-disable-next-line no-await-in-loop
	for (let i = 0; i < ticks; i++) await Promise.resolve()
}

export type Captured = {
	events: unknown[]
	[Symbol.dispose](): void
}

export let capture = function capture(name: string): Captured {
	let events: unknown[] = []
	let onMessage = (message: unknown) => events.push(message)
	subscribe(name, onMessage)
	return {
		events,
		[Symbol.dispose]() {
			unsubscribe(name, onMessage)
		},
	}
}

// ── Convenience wiring ──────────────────────────────────────────────────────

export type EndpointPoolHarness = EndpointsRuntime & {
	discovery: FakeDiscovery
	connections: FakeConnectionFactory
} & AsyncDisposable

export let makeEndpointPool = function makeEndpointPool(
	over: {
		discovery?: FakeDiscovery
		connections?: FakeConnectionFactory
		hooks?: DriverHooks
		localityEnabled?: boolean
		preferPrimaryPile?: boolean
		degradedThreshold?: number
		discoveryTimeoutMs?: number
		discoveryIntervalMs?: number
		idleIntervalMs?: number
		retiredGraceMs?: number
		closeDeadlineMs?: number
	} = {}
): EndpointPoolHarness {
	let discovery = over.discovery ?? makeFakeDiscovery()
	let connections = over.connections ?? makeFakeConnectionFactory()

	let runtime = createEndpointsRuntime({
		identity: TEST_IDENTITY,
		listEndpoints: discovery.listEndpoints,
		channelCredentials: credentials.createInsecure(),
		connectionFactory: connections.factory,
		hooks: over.hooks,
		localityEnabled: over.localityEnabled,
		preferPrimaryPile: over.preferPrimaryPile,
		degradedThreshold: over.degradedThreshold,
		discoveryTimeoutMs: over.discoveryTimeoutMs ?? 5_000,
		discoveryIntervalMs: over.discoveryIntervalMs ?? 60_000,
		idleIntervalMs: over.idleIntervalMs ?? 60_000,
		retiredGraceMs: over.retiredGraceMs ?? 300_000,
		closeDeadlineMs: over.closeDeadlineMs ?? 50,
	})

	return {
		...runtime,
		discovery,
		connections,
		async [Symbol.asyncDispose]() {
			await runtime.pool.close()
		},
	}
}
