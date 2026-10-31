import type { DriverIdentity } from '@ydbjs/core'

// Per-pile node count from a routing snapshot. `status` is the bridge pile
// status string (PRIMARY / SYNCHRONIZED / …), kept opaque here — telemetry
// only forwards it as a metric tag.
export type PileNodeCount = { name: string; status: string; nodes: number }

// Latest routing snapshot carried by `ydb:driver.connection.pool.stats`.
export type PoolStatsSnapshot = {
	total: number
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
}

export type PoolState = {
	// undefined until the first stats round lands; the pool gauges stay silent
	// until then rather than reporting a confident zero.
	stats: PoolStatsSnapshot | undefined
	// undefined for a subscriber that attached after driver construction and so
	// missed the one-shot `pool.opened`.
	config: PoolConfig | undefined
	// Every pile name ever seen for this driver. Cumulative temporality keeps
	// re-exporting an attribute set that stops being observed, so a pile that
	// leaves the roster has to be observed at 0 rather than simply dropped —
	// otherwise its last node count is reported forever.
	seenPiles: Set<string>
}

/**
 * Per-driver state of the gRPC connection pool.
 *
 * Two independent maps, deliberately not merged: `#connections` is
 * reconstructed from the `ydb:driver.connection.*` delta events, while
 * `#pools` mirrors the whole-snapshot `ydb:driver.connection.pool.*`
 * channels. Keeping them apart means a pool snapshot cannot materialize a
 * connection-count entry — otherwise a subscriber that attached late (and so
 * missed every `connection.added`) would start exporting a confident
 * `ydb.driver.connection.count{state=live} = 0` for a driver that in fact has
 * N live connections, where before it exported nothing at all.
 *
 * Both are keyed by `DriverIdentity` *reference* (Map identity), so callers
 * must pass the same identity object that the publisher stamps on each payload.
 */
export class ConnectionPoolRegistry {
	#connections = new Map<DriverIdentity, ConnectionState>()
	#pools = new Map<DriverIdentity, PoolState>()

	connections(): ReadonlyMap<DriverIdentity, ConnectionState> {
		return this.#connections
	}

	pools(): ReadonlyMap<DriverIdentity, PoolState> {
		return this.#pools
	}

	driverClosed(driver: DriverIdentity): void {
		this.#connections.delete(driver)
		this.#pools.delete(driver)
	}

	// `pool.opened` fires once at construction. Replace any state left by a
	// prior pool generation on the same identity, mirroring
	// `SessionPoolRegistry.poolOpened`.
	poolOpened(driver: DriverIdentity, config: PoolConfig): void {
		this.#pools.set(driver, { stats: undefined, config, seenPiles: new Set() })
	}

	// `pool.stats` re-emits on every routable-set change — replace the snapshot.
	poolStats(driver: DriverIdentity, stats: PoolStatsSnapshot): void {
		let s = this.#pool(driver)
		s.stats = stats
		for (let pile of stats.piles) s.seenPiles.add(pile.name)
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
			s = { live: 0, pessimized: 0 }
			this.#connections.set(driver, s)
		}
		return s
	}

	#pool(driver: DriverIdentity): PoolState {
		let s = this.#pools.get(driver)
		if (!s) {
			s = { stats: undefined, config: undefined, seenPiles: new Set() }
			this.#pools.set(driver, s)
		}
		return s
	}
}
