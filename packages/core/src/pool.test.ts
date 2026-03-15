import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, test, vi } from 'vitest'

import { connectivityState as ConnectivityState, credentials } from '@grpc/grpc-js'

import type { Connection } from './conn.js'
import type { EndpointInfo } from './hooks.js'
import {
	ConnectionPool,
	POOL_GET_ACTIVE_FOR_TESTING,
	POOL_GET_LAST_ACQUIRED_FOR_TESTING,
	POOL_GET_PESSIMIZED_FOR_TESTING,
	POOL_GET_RETIRED_FOR_TESTING,
	POOL_INJECT_FOR_TESTING,
	POOL_RUN_IDLE_SWEEP_FOR_TESTING,
} from './pool.js'

// ── Test helpers ───────────────────────────────────────────────────────────────

/**
 * Build a fake Connection that satisfies the Connection interface.
 * The channel is a plain object with a no-op close — no real grpc-js channels.
 */
function makeConn(
	nodeId: number,
	address = `node-${nodeId}:2136`,
	location = 'dc1',
	connectivityState: ConnectivityState = ConnectivityState.READY
): Connection {
	let endpoint: EndpointInfo = Object.freeze({ nodeId: BigInt(nodeId), address, location })
	return {
		endpoint,
		channel: {
			close: vi.fn(),
			getConnectivityState: vi.fn(() => connectivityState),
		} as unknown as Connection['channel'],
		close: vi.fn(),
		[Symbol.dispose]: vi.fn(),
	}
}

/**
 * Build a minimal fake EndpointInfo-like proto object that pool.add() / pool.sync() expects.
 * (The proto type has address, port, nodeId, location — not pre-joined 'host:port'.)
 */
function makeProtoEndpoint(nodeId: number, host = `node-${nodeId}`, port = 2136, location = 'dc1') {
	return { nodeId, address: host, port, location, sslTargetNameOverride: '' } as any
}

/**
 * Create a pool with optional hooks. Returns the pool and an inject helper.
 */
function makePool(
	hooks?: ConstructorParameters<typeof ConnectionPool>[0]['hooks'],
	options?: Partial<ConstructorParameters<typeof ConnectionPool>[0]>
) {
	// Use real insecure credentials — needed by pool.add() which calls
	// new GrpcConnection() → createChannel() internally.
	let pool = new ConnectionPool({
		hooks,
		channelCredentials: credentials.createInsecure(),
		// Disable idle sweep timer in tests — we trigger it manually via the test symbol
		idleTimeout: options?.idleTimeout ?? 0,
		idleInterval: options?.idleInterval ?? 0,
		pessimizationTimeout: 60_000,
		...options,
	})
	return { pool, inject: (conn: Connection) => pool[POOL_INJECT_FOR_TESTING](conn) }
}

/**
 * Read the active connections list via the pool's own activeSize / acquire().
 * For deep assertions we keep a reference to the injected connections directly.
 */
function getActive(pool: ConnectionPool): Connection[] {
	return pool[POOL_GET_ACTIVE_FOR_TESTING]()
}

/**
 * Read the pessimized map via a test escape-hatch.
 */
function getPessimized(pool: ConnectionPool): Map<Connection, number> {
	return pool[POOL_GET_PESSIMIZED_FOR_TESTING]()
}

function getRetired(pool: ConnectionPool): Connection[] {
	return [...pool[POOL_GET_RETIRED_FOR_TESTING]()]
}

function getLastAcquiredAt(pool: ConnectionPool): Map<Connection, number> {
	return pool[POOL_GET_LAST_ACQUIRED_FOR_TESTING]()
}

function runIdleSweep(pool: ConnectionPool): void {
	pool[POOL_RUN_IDLE_SWEEP_FOR_TESTING]()
}

// ── Round-robin ────────────────────────────────────────────────────────────────

test('acquire returns connections in round-robin order', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	let c3 = makeConn(3)
	inject(c1)
	inject(c2)
	inject(c3)

	// First pass
	expect(pool.acquire().endpoint.nodeId).toBe(1n)
	expect(pool.acquire().endpoint.nodeId).toBe(2n)
	expect(pool.acquire().endpoint.nodeId).toBe(3n)
	// Second pass wraps around
	expect(pool.acquire().endpoint.nodeId).toBe(1n)
	expect(pool.acquire().endpoint.nodeId).toBe(2n)
})

test('acquire with preferNodeId returns the preferred active connection', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	let got = pool.acquire(2n)
	expect(got.endpoint.nodeId).toBe(2n)
})

test('acquire with preferNodeId falls back to round-robin if preferred is absent', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	// nodeId 99 is not in pool — should return c1 via round-robin
	let got = pool.acquire(99n)
	expect(got.endpoint.nodeId).toBe(1n)
})

test('acquire throws when pool is empty', () => {
	let { pool } = makePool()
	expect(() => pool.acquire()).toThrow('No connection available')
})

// ── Pessimization ──────────────────────────────────────────────────────────────

test('pessimize moves connection from active to pessimized', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	pool.pessimize(c1)

	expect(getActive(pool)).not.toContain(c1)
	expect(getPessimized(pool).has(c1)).toBe(true)
	// c2 remains active
	expect(getActive(pool)).toContain(c2)
})

test('pessimize sets expiry timestamp in the future', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	let before = Date.now()
	pool.pessimize(c1)
	let after = Date.now()

	let until = getPessimized(pool).get(c1)!
	expect(until).toBeGreaterThan(before)
	expect(until).toBeLessThanOrEqual(after + 60_001)
})

test('pessimize is idempotent — refreshes expiry if already pessimized', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	pool.pessimize(c1)
	let first = getPessimized(pool).get(c1)!

	pool.pessimize(c1)
	let second = getPessimized(pool).get(c1)!

	// Second call refreshes the timestamp (≥ first)
	expect(second).toBeGreaterThanOrEqual(first)
	// Still only one entry in the map
	expect(getPessimized(pool).size).toBe(1)
})

test('acquire falls back to pessimized connection when pool has no active connections', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	pool.pessimize(c1)

	// No active connections remain — should return pessimized c1
	let got = pool.acquire()
	expect(got.endpoint.nodeId).toBe(1n)
})

test('acquire returns preferred pessimized node even when other active nodes exist', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	pool.pessimize(c1)

	// c1 is pessimized but specifically requested.
	// Sessions/transactions are bound to a nodeId — we must return c1 even
	// though c2 is active, otherwise the caller gets BAD_SESSION errors.
	let got = pool.acquire(1n)
	expect(got.endpoint.nodeId).toBe(1n)
})

test('pessimized connection is restored after timeout elapses', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	pool.pessimize(c1)

	// Manually backdate the expiry to simulate timeout
	getPessimized(pool).set(c1, Date.now() - 1)

	// acquire() calls #refreshPessimized() internally
	let got = pool.acquire()
	expect(got.endpoint.nodeId).toBe(1n)
	// c1 should be back in active list
	expect(getActive(pool)).toContain(c1)
	expect(getPessimized(pool).has(c1)).toBe(false)
})

// ── Metrics ────────────────────────────────────────────────────────────────────

test('activeSize and pessimizedSize reflect pool state', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	expect(pool.activeSize).toBe(2)
	expect(pool.pessimizedSize).toBe(0)

	pool.pessimize(c1)

	expect(pool.activeSize).toBe(1)
	expect(pool.pessimizedSize).toBe(1)
})

// ── isAvailable ────────────────────────────────────────────────────────────────

test('isAvailable returns true for active node', () => {
	let { pool, inject } = makePool()
	inject(makeConn(42))
	expect(pool.isAvailable(42n)).toBe(true)
})

test('isAvailable returns true for pessimized node', () => {
	let { pool, inject } = makePool()
	let c = makeConn(42)
	inject(c)
	pool.pessimize(c)
	expect(pool.isAvailable(42n)).toBe(true)
})

test('isAvailable returns false for unknown node', () => {
	let { pool, inject } = makePool()
	inject(makeConn(1))
	expect(pool.isAvailable(99n)).toBe(false)
})

test('isAvailable returns false after node is removed by sync', () => {
	let { pool } = makePool()
	pool.add(makeProtoEndpoint(1))
	pool.add(makeProtoEndpoint(2))

	// Sync with only node 2
	pool.sync([makeProtoEndpoint(2)])

	expect(pool.isAvailable(1n)).toBe(false)
	expect(pool.isAvailable(2n)).toBe(true)
})

// ── sync() ─────────────────────────────────────────────────────────────────────

test('sync adds new endpoints and returns them in added array', () => {
	let { pool } = makePool()

	let { added, removed } = pool.sync([makeProtoEndpoint(1), makeProtoEndpoint(2)])

	expect(added).toHaveLength(2)
	expect(added.map((e) => e.nodeId)).toContain(1n)
	expect(added.map((e) => e.nodeId)).toContain(2n)
	expect(removed).toHaveLength(0)
	expect(pool.activeSize).toBe(2)
})

test('sync removes stale endpoints and returns them in removed array', () => {
	let { pool } = makePool()
	pool.add(makeProtoEndpoint(1))
	pool.add(makeProtoEndpoint(2))
	pool.add(makeProtoEndpoint(3))

	// Discovery returns only node 2
	let { added, removed } = pool.sync([makeProtoEndpoint(2)])

	expect(removed.map((e) => e.nodeId)).toContain(1n)
	expect(removed.map((e) => e.nodeId)).toContain(3n)
	expect(added).toHaveLength(0)
	expect(pool.activeSize).toBe(1)
})

test('sync does NOT close channels of removed endpoints', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	// Inject directly so we control the close mock
	inject(c1)
	// Add node 2 via normal path
	pool.add(makeProtoEndpoint(2))

	// Remove node 1 from routing
	pool.sync([makeProtoEndpoint(2)])

	// c1's close() must NOT have been called — existing streams stay alive
	expect(c1.close).not.toHaveBeenCalled()
})

test('sync also removes pessimized endpoints that disappeared from discovery', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)
	pool.pessimize(c1)
	pool.add(makeProtoEndpoint(2))

	let { removed } = pool.sync([makeProtoEndpoint(2)])

	expect(removed.map((e) => e.nodeId)).toContain(1n)
	expect(getPessimized(pool).has(c1)).toBe(false)
	// Channel is NOT closed for pessimized endpoints either
	expect(c1.close).not.toHaveBeenCalled()
})

test('sync handles re-appeared endpoint — replaces connection', () => {
	let { pool } = makePool()
	pool.add(makeProtoEndpoint(1))
	pool.add(makeProtoEndpoint(2))

	// Node 1 disappears
	pool.sync([makeProtoEndpoint(2)])
	expect(pool.activeSize).toBe(1)

	// Node 1 re-appears in next discovery
	pool.sync([makeProtoEndpoint(1), makeProtoEndpoint(2)])
	expect(pool.activeSize).toBe(2)
	expect(pool.isAvailable(1n)).toBe(true)
})

test('sync returns correct added/removed on partial overlap', () => {
	let { pool } = makePool()
	pool.add(makeProtoEndpoint(1))
	pool.add(makeProtoEndpoint(2))

	// Discovery: node 2 stays, node 3 is new, node 1 is gone
	let { added, removed } = pool.sync([makeProtoEndpoint(2), makeProtoEndpoint(3)])

	expect(added.map((e) => e.nodeId)).toEqual([3n])
	expect(removed.map((e) => e.nodeId)).toEqual([1n])
})

// ── add() ──────────────────────────────────────────────────────────────────────

test('add closes old channel when replacing existing nodeId', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	// Adding the same nodeId again should replace
	pool.add(makeProtoEndpoint(1))

	expect(c1.close).toHaveBeenCalledOnce()
})

test('add replaces pessimized connection with same nodeId', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)
	pool.pessimize(c1)

	pool.add(makeProtoEndpoint(1))

	expect(c1.close).toHaveBeenCalledOnce()
	// The new connection should be in active list, not pessimized
	expect(getPessimized(pool).has(c1)).toBe(false)
	expect(pool.activeSize).toBe(1)
})

// ── close() ────────────────────────────────────────────────────────────────────

test('close calls close() on all active connections', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	pool.close()

	expect(c1.close).toHaveBeenCalledOnce()
	expect(c2.close).toHaveBeenCalledOnce()
})

test('close calls close() on pessimized connections', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)
	pool.pessimize(c1)

	pool.close()

	expect(c1.close).toHaveBeenCalledOnce()
})

test('Symbol.dispose closes the pool', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	pool[Symbol.dispose]()

	expect(c1.close).toHaveBeenCalledOnce()
})

// ── Telemetry hooks ────────────────────────────────────────────────────────────

test('onPessimize hook fires when a connection is pessimized', () => {
	let onPessimize = vi.fn()
	let { pool, inject } = makePool({ onPessimize })
	let c1 = makeConn(1, 'host:2136', 'dc1')
	inject(c1)

	pool.pessimize(c1)

	expect(onPessimize).toHaveBeenCalledOnce()
	expect(onPessimize).toHaveBeenCalledWith({ endpoint: c1.endpoint })
})

test('onUnpessimize hook fires when a connection is restored', () => {
	let onUnpessimize = vi.fn()
	let { pool, inject } = makePool({ onUnpessimize })
	let c1 = makeConn(1)
	inject(c1)

	pool.pessimize(c1)
	// Backdate expiry so the refresh happens on next acquire()
	getPessimized(pool).set(c1, Date.now() - 1)

	pool.acquire()

	expect(onUnpessimize).toHaveBeenCalledOnce()
	let event = onUnpessimize.mock.calls[0]![0]!
	expect(event.endpoint).toBe(c1.endpoint)
})

test('hook errors are swallowed and do not affect the pool', () => {
	let onPessimize = vi.fn(() => {
		throw new Error('hook explosion')
	})
	let { pool, inject } = makePool({ onPessimize })
	let c1 = makeConn(1)
	inject(c1)

	// Must not throw even though the hook throws
	expect(() => pool.pessimize(c1)).not.toThrow()
})

// ── BalancedChannel (behavioral tests via pool) ────────────────────────────────
// Full BalancedChannel tests require a real grpc-js Call, which is complex to
// mock without integration infrastructure. We test the connection-selection and
// pessimization logic through the pool, which is the core contract.

test('round-robin distributes load evenly across N connections', () => {
	let { pool, inject } = makePool()
	let nodes = [1, 2, 3, 4, 5].map((id) => makeConn(id))
	nodes.forEach((c) => inject(c))

	let counts = new Map<bigint, number>()
	for (let i = 0; i < 50; i++) {
		let conn = pool.acquire()
		counts.set(conn.endpoint.nodeId, (counts.get(conn.endpoint.nodeId) ?? 0) + 1)
	}

	// Each node should receive exactly 10 requests (50 / 5)
	for (let [, count] of counts) {
		expect(count).toBe(10)
	}
})

test('round-robin skips pessimized nodes', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	let c3 = makeConn(3)
	inject(c1)
	inject(c2)
	inject(c3)

	pool.pessimize(c2)

	let seen = new Set<bigint>()
	for (let i = 0; i < 20; i++) {
		seen.add(pool.acquire().endpoint.nodeId)
	}

	expect(seen).not.toContain(2n)
	expect(seen).toContain(1n)
	expect(seen).toContain(3n)
})

// ── Async context preservation (pool-level hook firing) ───────────────────────

test('onPessimize hook fires synchronously (no async context loss)', () => {
	let store = new AsyncLocalStorage<{ requestId: string }>()
	let capturedRequestId: string | undefined

	let { pool, inject } = makePool({
		onPessimize() {
			capturedRequestId = store.getStore()?.requestId
		},
	})
	let c1 = makeConn(1)
	inject(c1)

	store.run({ requestId: 'req-42' }, () => {
		pool.pessimize(c1)
	})

	// Pool-level hooks fire synchronously, so ALS context is preserved naturally
	expect(capturedRequestId).toBe('req-42')
})

test('onUnpessimize hook fires synchronously with correct ALS context', () => {
	let store = new AsyncLocalStorage<{ traceId: string }>()
	let capturedTraceId: string | undefined

	let { pool, inject } = makePool({
		onUnpessimize() {
			capturedTraceId = store.getStore()?.traceId
		},
	})
	let c1 = makeConn(1)
	inject(c1)
	pool.pessimize(c1)
	getPessimized(pool).set(c1, Date.now() - 1)

	store.run({ traceId: 'trace-abc' }, () => {
		pool.acquire() // triggers #refreshPessimized → onUnpessimize
	})

	expect(capturedTraceId).toBe('trace-abc')
})

// ── Concurrent acquire (robustness) ───────────────────────────────────────────

test('acquire with preferNodeId removed by sync falls back to round-robin', () => {
	let { pool } = makePool()
	pool.add(makeProtoEndpoint(1))
	pool.add(makeProtoEndpoint(2))
	pool.add(makeProtoEndpoint(3))

	// Node 2 disappears from discovery
	pool.sync([makeProtoEndpoint(1), makeProtoEndpoint(3)])

	// Requesting node 2 should NOT throw — it should fall back to round-robin
	// over the remaining active connections (1 and 3).
	let got = pool.acquire(2n)
	expect([1n, 3n]).toContain(got.endpoint.nodeId)

	// Confirm node 2 is truly gone
	expect(pool.isAvailable(2n)).toBe(false)
})

test('concurrent acquire calls all resolve to valid connections', async () => {
	let { pool, inject } = makePool()
	let nodes = [1, 2, 3].map((id) => makeConn(id))
	nodes.forEach((c) => inject(c))

	// Simulate concurrent acquire calls from multiple "requests"
	let results = await Promise.all(
		Array.from({ length: 30 }, () =>
			Promise.resolve().then(() => pool.acquire().endpoint.nodeId)
		)
	)

	expect(results).toHaveLength(30)
	for (let nodeId of results) {
		expect([1n, 2n, 3n]).toContain(nodeId)
	}
})

// ── Idle connection cleanup ───────────────────────────────────────────────────

test('acquire updates lastAcquiredAt timestamp', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	let before = Date.now()
	pool.acquire()
	let after = Date.now()

	let ts = getLastAcquiredAt(pool).get(c1)
	expect(ts).toBeGreaterThanOrEqual(before)
	expect(ts).toBeLessThanOrEqual(after)
})

test('acquire updates lastAcquiredAt for preferred node', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	pool.acquire(2n)

	let ts = getLastAcquiredAt(pool).get(c2)
	expect(ts).toBeDefined()
	expect(ts).toBeGreaterThan(0)
})

test('sync moves removed connections to retired list', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	pool.sync([makeProtoEndpoint(2)])

	expect(getRetired(pool)).toContain(c1)
	expect(getRetired(pool)).not.toContain(c2)
	expect(pool.retiredSize).toBe(1)
	// Channel NOT closed
	expect(c1.close).not.toHaveBeenCalled()
})

test('sync moves pessimized removed connections to retired list', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)
	pool.pessimize(c1)
	pool.add(makeProtoEndpoint(2))

	pool.sync([makeProtoEndpoint(2)])

	expect(getRetired(pool)).toContain(c1)
	expect(c1.close).not.toHaveBeenCalled()
})

test('idle sweep closes retired connections with IDLE state', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1, 'node-1:2136', 'dc1', ConnectivityState.IDLE)
	inject(c1)

	// Move c1 to retired
	pool.sync([])

	expect(getRetired(pool)).toContain(c1)

	// Run idle sweep — c1 is IDLE → should be closed
	runIdleSweep(pool)

	expect(getRetired(pool)).not.toContain(c1)
	expect(c1.close).toHaveBeenCalledOnce()
})

test('idle sweep closes retired connections with TRANSIENT_FAILURE state', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1, 'node-1:2136', 'dc1', ConnectivityState.TRANSIENT_FAILURE)
	inject(c1)

	pool.sync([])
	runIdleSweep(pool)

	expect(getRetired(pool)).toHaveLength(0)
	expect(c1.close).toHaveBeenCalledOnce()
})

test('idle sweep does NOT close retired connections with READY state', () => {
	let { pool, inject } = makePool()
	// READY = likely has an active stream (topic reader/writer)
	let c1 = makeConn(1, 'node-1:2136', 'dc1', ConnectivityState.READY)
	inject(c1)

	pool.sync([])
	runIdleSweep(pool)

	// c1 is READY — stream still active, must NOT be closed
	expect(getRetired(pool)).toContain(c1)
	expect(c1.close).not.toHaveBeenCalled()
})

test('idle sweep closes active connection unused beyond TTL when not READY', () => {
	let { pool, inject } = makePool(undefined, { idleTimeout: 1000 })
	let c1 = makeConn(1, 'node-1:2136', 'dc1', ConnectivityState.IDLE)
	inject(c1)

	// Backdate the lastAcquiredAt to simulate being idle for > TTL
	getLastAcquiredAt(pool).set(c1, Date.now() - 2000)

	runIdleSweep(pool)

	expect(getActive(pool)).not.toContain(c1)
	expect(c1.close).toHaveBeenCalledOnce()
})

test('idle sweep does NOT close active connection unused beyond TTL when READY', () => {
	let { pool, inject } = makePool(undefined, { idleTimeout: 1000 })
	// READY = has active stream, even though acquire() hasn't been called recently
	let c1 = makeConn(1, 'node-1:2136', 'dc1', ConnectivityState.READY)
	inject(c1)

	// Backdate to simulate being idle for > TTL
	getLastAcquiredAt(pool).set(c1, Date.now() - 2000)

	runIdleSweep(pool)

	// c1 is READY — stream still active, must NOT be closed even though TTL expired
	expect(getActive(pool)).toContain(c1)
	expect(c1.close).not.toHaveBeenCalled()
})

test('idle sweep does NOT close active connection within TTL', () => {
	let { pool, inject } = makePool(undefined, { idleTimeout: 60_000 })
	let c1 = makeConn(1, 'node-1:2136', 'dc1', ConnectivityState.IDLE)
	inject(c1)

	// lastAcquiredAt was just set by inject → well within TTL
	runIdleSweep(pool)

	expect(getActive(pool)).toContain(c1)
	expect(c1.close).not.toHaveBeenCalled()
})

test('close() also closes retired connections', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	let c2 = makeConn(2)
	inject(c1)
	inject(c2)

	// Retire c1
	pool.sync([makeProtoEndpoint(2)])

	pool.close()

	expect(c1.close).toHaveBeenCalledOnce()
	expect(c2.close).toHaveBeenCalledOnce()
	expect(pool.retiredSize).toBe(0)
})

test('add() cleans up retired connection with same nodeId', () => {
	let { pool, inject } = makePool()
	let c1 = makeConn(1)
	inject(c1)

	// Retire c1
	pool.sync([])
	expect(getRetired(pool)).toContain(c1)

	// Re-add node 1 — should close the retired connection
	pool.add(makeProtoEndpoint(1))

	expect(getRetired(pool)).not.toContain(c1)
	expect(c1.close).toHaveBeenCalledOnce()
	expect(pool.activeSize).toBe(1)
})
