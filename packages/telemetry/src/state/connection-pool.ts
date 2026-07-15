import type { DriverIdentity } from '@ydbjs/core'

// Per-pile node count from a routing snapshot. `status` is the bridge pile
// status string (PRIMARY / SYNCHRONIZED / …), kept opaque here — telemetry
// only forwards it as a metric tag.
export type PileNodeCount = { name: string; status: string; nodes: number }

// Latest routing snapshot carried by `ydb:driver.connection.pool.stats`.
export type PoolStatsSnapshot = {
	prefer: number
	fallback: number
	pessimized: number
	piles: PileNodeCount[]
}

// Routing mode carried by `ydb:driver.connection.pool.opened`. Only the flags
// that change what `prefer`/`fallback` mean are folded in — the interval /
// threshold config fields have no metric representation.
export type PoolConfig = {
	preferPrimaryPile: boolean
	localityEnabled: boolean
}

export type ConnectionState = {
	live: number
	pessimized: number
	// Latest `pool.stats` snapshot; undefined until the first stats round lands
	// (or a late subscriber that missed it — then the pool gauges stay silent).
	stats: PoolStatsSnapshot | undefined
	// Routing config from the once-fired `pool.opened`; undefined for a late
	// subscriber that attached after construction.
	config: PoolConfig | undefined
}

/**
 * Per-driver state of the gRPC connection pool, rebuilt from
 * `ydb:driver.connection.*` events. Keyed by `DriverIdentity` *reference*
 * (Map identity), so callers must pass the same identity object that the
 * publisher stamps on each payload.
 */
export class ConnectionPoolRegistry {
	#connections = new Map<DriverIdentity, ConnectionState>()

	connections(): ReadonlyMap<DriverIdentity, ConnectionState> {
		return this.#connections
	}

	driverClosed(driver: DriverIdentity): void {
		this.#connections.delete(driver)
	}

	// `pool.opened` fires once at construction, before any connection event, so
	// it just seeds the routing config onto the (fresh) entry.
	poolOpened(driver: DriverIdentity, config: PoolConfig): void {
		this.#get(driver).config = config
	}

	// `pool.stats` re-emits on every routable-set change — replace the snapshot.
	poolStats(driver: DriverIdentity, stats: PoolStatsSnapshot): void {
		this.#get(driver).stats = stats
	}

	connectionAdded(driver: DriverIdentity): void {
		this.#get(driver).live += 1
	}

	connectionPessimized(driver: DriverIdentity): void {
		let s = this.#get(driver)
		s.live = Math.max(0, s.live - 1)
		s.pessimized += 1
	}

	connectionUnpessimized(driver: DriverIdentity): void {
		let s = this.#get(driver)
		s.pessimized = Math.max(0, s.pessimized - 1)
		s.live += 1
	}

	// `retired` and `removed` collapse into one transition: the connection is
	// gone. The event doesn't carry the prior bucket, so we drain whichever
	// has stock.
	connectionRemoved(driver: DriverIdentity): void {
		let s = this.#get(driver)
		if (s.live > 0) s.live -= 1
		else if (s.pessimized > 0) s.pessimized -= 1
	}

	#get(driver: DriverIdentity): ConnectionState {
		let s = this.#connections.get(driver)
		if (!s) {
			s = { live: 0, pessimized: 0, stats: undefined, config: undefined }
			this.#connections.set(driver, s)
		}
		return s
	}
}
