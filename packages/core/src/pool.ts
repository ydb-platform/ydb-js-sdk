import { channel as dc } from 'node:diagnostics_channel'

import { connectivityState } from '@grpc/grpc-js'
import type { EndpointInfo as ProtoEndpointInfo } from '@ydbjs/api/discovery'
import { loggers } from '@ydbjs/debug'
import type { ChannelCredentials, ChannelOptions } from 'nice-grpc'

import { type Connection, GrpcConnection } from './conn.js'
import type { DriverHooks, EndpointInfo } from './hooks.js'

/**
 * Reasons a connection was retired from active routing while its gRPC
 * channel is left open to drain in-flight streams. See `#retireConnection`.
 */
type RetiredReason = 'stale_active' | 'stale_pessimized'

/**
 * Reasons a connection's gRPC channel was physically closed.
 *   - 'replaced'   — discovery returned the same nodeId, channel was rebuilt.
   - 'idle'       — idle sweep closed an unused or drained channel.
 *   - 'pool_close' — pool itself is shutting down.
 * See `#dropConnection`.
 */
type RemovedReason = 'replaced' | 'idle' | 'pool_close'

export const POOL_INJECT_FOR_TESTING: unique symbol = Symbol('POOL_INJECT')
export const POOL_GET_ACTIVE_FOR_TESTING: unique symbol = Symbol('POOL_ACTIVE')
export const POOL_GET_RETIRED_FOR_TESTING: unique symbol = Symbol('POOL_RETIRED')
export const POOL_GET_PESSIMIZED_FOR_TESTING: unique symbol = Symbol('POOL_PESSIMIZED')
export const POOL_RUN_IDLE_SWEEP_FOR_TESTING: unique symbol = Symbol('POOL_RUN_IDLE_SWEEP')
export const POOL_GET_LAST_ACQUIRED_FOR_TESTING: unique symbol = Symbol('POOL_LAST_ACQUIRED')

let dbg = loggers.driver.extend('pool')

export interface ConnectionPoolOptions {
	hooks?: DriverHooks | undefined
	channelOptions?: ChannelOptions | undefined
	channelCredentials: ChannelCredentials
	idleTimeout: number
	idleInterval: number
	pessimizationTimeout: number
}

export class ConnectionPool implements Disposable {
	readonly options: ConnectionPoolOptions

	#connections: Connection[] = []
	#pessimized: Map<Connection, number> = new Map()
	#acquired: Map<Connection, number> = new Map()
	#retired: Set<Connection> = new Set()
	#index = 0

	#idleTimer?: NodeJS.Timeout

	constructor(options: ConnectionPoolOptions) {
		this.options = options
		if (options.idleInterval) {
			this.#startIdleSweep()
		}
	}

	get activeSize(): number {
		return this.#connections.length
	}

	get retiredSize(): number {
		return this.#retired.size
	}

	get pessimizedSize(): number {
		return this.#pessimized.size
	}

	/**
	 * Acquire a connection for an RPC.
	 *
	 * Priority order:
	 *   1. Preferred node (active), if preferNodeId is given
	 *   2. Round-robin over active connections
	 *   3. Preferred node (pessimized) — sessions/transactions are node-bound
	 *   4. Any pessimized connection — last resort when pool is fully pessimized
	 *
	 * Note: returning a pessimized preferred node is intentional. Sessions and
	 * transactions are bound to a specific nodeId. Silently routing to a different
	 * node would cause BAD_SESSION errors that are harder to diagnose than an
	 * explicit transport error.
	 */
	acquire(preferNodeId?: bigint): Connection {
		this.#refreshPessimized()

		if (preferNodeId !== undefined) {
			// 1. Preferred active
			let preferred = this.#findActive(preferNodeId)
			if (preferred) {
				this.#acquired.set(preferred, Date.now())
				return preferred
			}

			// 2. Preferred pessimized
			let preferredPessimized = this.#findPessimized(preferNodeId)
			if (preferredPessimized) {
				this.#acquired.set(preferredPessimized, Date.now())
				return preferredPessimized
			}
		}

		// 3. Round-robin active connection
		if (this.#connections.length > 0) {
			let conn = this.#connections[this.#index % this.#connections.length]!
			this.#index++
			this.#acquired.set(conn, Date.now())
			return conn
		}

		// 4. Any pessimized connection
		if (this.#pessimized.size > 0) {
			for (let [conn] of this.#pessimized) {
				this.#acquired.set(conn, Date.now())
				return conn
			}
		}

		throw new Error('No connection available')
	}

	/**
	 * Pessimize a connection — move it out of active rotation for
	 * PESSIMIZATION_TIMEOUT_MS milliseconds.
	 */
	pessimize(conn: Connection): void {
		let index = this.#connections.indexOf(conn)
		if (index !== -1) {
			this.#connections.splice(index, 1)
		}

		// Don't double-pessimize — refresh the timestamp if already pessimized
		let until = Date.now() + this.options.pessimizationTimeout
		this.#pessimized.set(conn, until)

		dbg.log('pessimized node %d address %s', conn.endpoint.nodeId, conn.endpoint.address)

		dc('ydb:pool.connection.pessimized').publish({
			nodeId: conn.endpoint.nodeId,
			address: conn.endpoint.address,
			location: conn.endpoint.location,
			until,
		})

		this.#safeHook('onPessimize', () => {
			this.options.hooks?.onPessimize?.({ endpoint: conn.endpoint })
		})
	}

	/**
	 * Add (or replace) an endpoint in the pool.
	 *
	 * If a connection with the same nodeId already exists (active or pessimized),
	 * it is closed and replaced with a fresh GrpcConnection. This handles the case
	 * where an endpoint disappears from discovery and later re-appears — it gets a
	 * clean channel.
	 */
	add(endpoint: ProtoEndpointInfo): void {
		let nodeId = BigInt(endpoint.nodeId)

		// Remove from active
		for (let i = this.#connections.length - 1; i >= 0; i--) {
			if (this.#connections[i]!.endpoint.nodeId !== nodeId) {
				continue
			}

			let old = this.#connections.splice(i, 1)[0]!
			this.#acquired.delete(old)
			this.#dropConnection(old, 'replaced')
			dbg.log('replaced active connection to node %d', nodeId)
		}

		// Remove from pessimized
		for (let [conn] of this.#pessimized) {
			if (conn.endpoint.nodeId !== nodeId) {
				continue
			}

			this.#pessimized.delete(conn)
			this.#acquired.delete(conn)
			this.#dropConnection(conn, 'replaced')
			dbg.log('replaced pessimized connection to node %d', nodeId)
		}

		// Remove from retired
		for (let conn of this.#retired) {
			if (conn.endpoint.nodeId !== nodeId) {
				continue
			}

			this.#retired.delete(conn)
			this.#dropConnection(conn, 'replaced')
			dbg.log('replaced retired connection to node %d', nodeId)
		}

		let conn = new GrpcConnection(
			endpoint,
			this.options.channelCredentials,
			this.options.channelOptions
		)

		this.#connections.push(conn)

		dbg.log(
			'added connection to node %d address %s (pool size: %d)',
			conn.endpoint.nodeId,
			conn.endpoint.address,
			this.#connections.length
		)

		dc('ydb:pool.connection.added').publish({
			nodeId: conn.endpoint.nodeId,
			address: conn.endpoint.address,
			location: conn.endpoint.location,
		})
	}

	/**
	 * Atomically sync the pool with a fresh discovery endpoint list.
	 *
	 * Endpoints no longer present in the list are removed from routing but
	 * their gRPC channels are NOT closed — existing streams (topic reader/writer,
	 * coordination sessions) continue to work. Removed connections are moved to
	 * the #retired list where the idle sweep will close them once grpc-js reports
	 * the channel as IDLE (all streams ended).
	 *
	 * New endpoints are added via add(), which also handles re-appeared endpoints.
	 *
	 * Returns { added, removed } for the onDiscovery hook.
	 */
	sync(endpoints: ProtoEndpointInfo[]): { added: EndpointInfo[]; removed: EndpointInfo[] } {
		let added: EndpointInfo[] = []
		let removed: EndpointInfo[] = []

		let discoveredNodeIds = new Set(endpoints.map((e) => BigInt(e.nodeId)))

		// Remove stale endpoints from active list.
		// Move to #retired — channel stays open for existing streams.
		for (let i = this.#connections.length - 1; i >= 0; i--) {
			let conn = this.#connections[i]!
			if (discoveredNodeIds.has(conn.endpoint.nodeId)) {
				continue
			}

			this.#connections.splice(i, 1)
			this.#acquired.delete(conn)
			this.#retireConnection(conn, 'stale_active')
			removed.push(conn.endpoint)
		}

		// Remove stale endpoints from pessimized map.
		// Move to #retired — channel stays open for existing streams.
		for (let conn of this.#pessimized.keys()) {
			if (discoveredNodeIds.has(conn.endpoint.nodeId)) {
				continue
			}

			this.#pessimized.delete(conn)
			this.#acquired.delete(conn)
			this.#retireConnection(conn, 'stale_pessimized')
			removed.push(conn.endpoint)
		}

		// Determine which endpoints in the discovery response are genuinely new
		// (not already present in active or pessimized sets). We snapshot the set
		// BEFORE calling add() because add() mutates #connections.
		let existingNodeIds = new Set<bigint>()

		for (let conn of this.#connections) {
			existingNodeIds.add(conn.endpoint.nodeId)
		}

		for (let conn of this.#pessimized.keys()) {
			existingNodeIds.add(conn.endpoint.nodeId)
		}

		for (let endpoint of endpoints) {
			let nodeId = BigInt(endpoint.nodeId)
			if (!existingNodeIds.has(nodeId)) {
				// Genuinely new endpoint — create a fresh connection.
				this.add(endpoint)

				let address = `${endpoint.address}:${endpoint.port}`
				added.push(
					Object.freeze<EndpointInfo>({
						nodeId,
						address,
						location: endpoint.location,
					})
				)
			}
		}

		dbg.log(
			'sync complete: %d added, %d removed, %d retired, pool size: %d',
			added.length,
			removed.length,
			this.#retired.size,
			this.#connections.length
		)

		return { added, removed }
	}

	/**
	 * Check whether a nodeId is currently routable (active or pessimized).
	 */
	isAvailable(nodeId: bigint): boolean {
		for (let conn of this.#connections) {
			if (conn.endpoint.nodeId === nodeId) {
				return true
			}
		}

		for (let conn of this.#pessimized.keys()) {
			if (conn.endpoint.nodeId === nodeId) {
				return true
			}
		}

		return false
	}

	/**
	 * Close all connections (active, pessimized, and retired) and clear the pool.
	 * Stops the idle sweep timer. Called by Driver.close() / Symbol.dispose.
	 */
	close(): void {
		dbg.log(
			'closing connection pool (%d active, %d pessimized, %d retired)',
			this.#connections.length,
			this.#pessimized.size,
			this.#retired.size
		)

		if (this.#idleTimer) {
			clearInterval(this.#idleTimer)
		}

		for (let conn of this.#connections) {
			this.#dropConnection(conn, 'pool_close')
		}

		for (let conn of this.#pessimized.keys()) {
			this.#dropConnection(conn, 'pool_close')
		}

		for (let conn of this.#retired) {
			this.#dropConnection(conn, 'pool_close')
		}

		this.#connections.length = 0
		this.#connections = []
		this.#pessimized.clear()
		this.#acquired.clear()
		this.#retired.clear()

		dbg.log('connection pool closed')
	}

	[Symbol.dispose](): void {
		this.close()
	}

	#findActive(nodeId: bigint): Connection | undefined {
		return this.#connections.find((c) => c.endpoint.nodeId === nodeId)
	}

	#findPessimized(nodeId: bigint): Connection | undefined {
		for (let [conn] of this.#pessimized) {
			if (conn.endpoint.nodeId === nodeId) {
				return conn
			}
		}

		return undefined
	}

	/**
	 * Restore any pessimized connections whose timeout has elapsed back into
	 * the active rotation. Called at the start of every acquire().
	 */
	#refreshPessimized(): void {
		let now = Date.now()

		for (let [conn, until] of this.#pessimized) {
			if (until < now) {
				this.#pessimized.delete(conn)
				this.#connections.push(conn)

				dbg.log(
					'un-pessimized node %d address %s',
					conn.endpoint.nodeId,
					conn.endpoint.address
				)

				dc('ydb:pool.connection.unpessimized').publish({
					nodeId: conn.endpoint.nodeId,
					address: conn.endpoint.address,
					location: conn.endpoint.location,
					pessimizedDuration: this.options.pessimizationTimeout - (until - now),
				})

				this.#safeHook('onUnpessimize', () => {
					this.options.hooks?.onUnpessimize?.({ endpoint: conn.endpoint })
				})
			}
		}
	}

	/**
	 * Start the background idle sweep timer.
	 *
	 * The sweep checks two categories of connections:
	 *
	 * 1. **Retired connections** (removed by sync(), channel left open for streams):
	 *    Closed as soon as getConnectivityState(false) reports IDLE, TRANSIENT_FAILURE,
	 *    or SHUTDOWN — meaning all streams have ended and grpc-js closed the transport.
	 *    READY means a stream is likely still active — leave it alone.
	 *
	 * 2. **Active connections** unused for longer than #idleTtlMs:
	 *    Closed only if BOTH conditions are met:
	 *    - Not acquired for longer than the TTL
	 *    - getConnectivityState(false) is not READY (no active streams)
	 *    This prevents closing channels that serve long-lived streams even if
	 *    acquire() hasn't been called recently (e.g., topic reader started once).
	 */
	#startIdleSweep(): void {
		this.#idleTimer = setInterval(() => {
			this.#idleSweep()
		}, this.options.idleInterval)

		// Don't prevent process exit
		this.#idleTimer.unref()

		dbg.log(
			'idle sweep started: check every %d ms, active TTL %d ms',
			this.options.idleInterval,
			this.options.idleTimeout
		)
	}

	/**
	 * Run one pass of the idle connection sweep.
	 * Called by the background timer and by the test escape hatch.
	 */
	#idleSweep(): void {
		let now = Date.now()

		let idleStates = [
			connectivityState.IDLE,
			connectivityState.TRANSIENT_FAILURE,
			connectivityState.SHUTDOWN,
		]

		for (let conn of this.#retired) {
			let state = conn.channel.getConnectivityState(false)

			if (idleStates.includes(state)) {
				this.#retired.delete(conn)
				this.#dropConnection(conn, 'idle')
			}
		}

		for (let i = this.#connections.length - 1; i >= 0; i--) {
			let conn = this.#connections[i]!
			let lastUsed = this.#acquired.get(conn) ?? 0
			let unusedMs = now - lastUsed

			if (unusedMs > this.options.idleTimeout) {
				let state = conn.channel.getConnectivityState(false)
				if (state !== connectivityState.READY) {
					this.#connections.splice(i, 1)
					this.#acquired.delete(conn)
					this.#dropConnection(conn, 'idle')
				}
			}
		}
	}

	/**
	 * Invoke a hook callback and swallow any errors it throws.
	 *
	 * Hooks must never affect the request path. If a hook throws, log it and
	 * continue. The hook author gets a debug message; the RPC is unaffected.
	 */
	#safeHook(name: string, fn: () => void): void {
		try {
			fn()
		} catch (error) {
			dbg.log('hook %s threw an error (swallowed): %O', name, error)
		}
	}

	/**
	 * Move a connection to the retired set. The gRPC channel stays open so
	 * in-flight streams can drain; the idle sweep closes it later. Caller
	 * removes the connection from `#connections` / `#pessimized` first.
	 */
	#retireConnection(conn: Connection, reason: RetiredReason): void {
		this.#retired.add(conn)

		dbg.log(
			'retired node %d address %s (reason: %s)',
			conn.endpoint.nodeId,
			conn.endpoint.address,
			reason
		)

		dc('ydb:pool.connection.retired').publish({
			nodeId: conn.endpoint.nodeId,
			address: conn.endpoint.address,
			location: conn.endpoint.location,
			reason,
		})
	}

	/**
	 * Close a connection's gRPC channel. Caller removes the connection from
	 * any container (active list, pessimized map, retired set) first.
	 */
	#dropConnection(conn: Connection, reason: RemovedReason): void {
		conn.close()

		dbg.log(
			'closed node %d address %s (reason: %s)',
			conn.endpoint.nodeId,
			conn.endpoint.address,
			reason
		)

		dc('ydb:pool.connection.removed').publish({
			nodeId: conn.endpoint.nodeId,
			address: conn.endpoint.address,
			location: conn.endpoint.location,
			reason,
		})
	}

	/**
	 * Inject a pre-built Connection directly into the active list.
	 *
	 * @internal
	 */
	[POOL_INJECT_FOR_TESTING](conn: Connection): void {
		this.#connections.push(conn)
		this.#acquired.set(conn, Date.now())
	}

	/**
	 * Return the active connections array (read-only view).
	 *
	 * @internal
	 */
	[POOL_GET_ACTIVE_FOR_TESTING](): Connection[] {
		return this.#connections
	}

	/**
	 * Return the pessimized Map (conn → pessimizedUntil timestamp).
	 *
	 * @internal
	 */
	[POOL_GET_PESSIMIZED_FOR_TESTING](): Map<Connection, number> {
		return this.#pessimized
	}

	/**
	 * Return the retired connections list.
	 *
	 * @internal
	 */
	[POOL_GET_RETIRED_FOR_TESTING](): Set<Connection> {
		return this.#retired
	}

	/**
	 * Return the lastAcquiredAt Map (conn → timestamp).
	 *
	 * @internal
	 */
	[POOL_GET_LAST_ACQUIRED_FOR_TESTING](): Map<Connection, number> {
		return this.#acquired
	}

	/**
	 * Run the idle sweep synchronously (same logic as the background timer).
	 * Useful in tests to avoid waiting for real timers.
	 *
	 * @internal
	 */
	[POOL_RUN_IDLE_SWEEP_FOR_TESTING](): void {
		this.#idleSweep()
	}
}
