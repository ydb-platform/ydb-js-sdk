import type { DriverIdentity } from '@ydbjs/core'

export type ConnectionState = {
	live: number
	pessimized: number
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
}
