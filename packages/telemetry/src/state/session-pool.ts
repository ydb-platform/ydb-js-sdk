import type { DriverIdentity } from '@ydbjs/core'

export type SessionPoolState = {
	/** Sessions registered with the pool (idle + busy). */
	total: number
	/** Sessions currently held by a `SessionLease`. */
	acquired: number
	/** In-flight `Session.open` calls. */
	creating: number
	/** Length of the wait queue. */
	waiters: number
	maxSize: number
	minSize: number
}

let EMPTY: SessionPoolState = {
	total: 0,
	acquired: 0,
	creating: 0,
	waiters: 0,
	maxSize: 0,
	minSize: 0,
}

/**
 * Per-driver state of the query session pool, rebuilt from
 * `ydb:query.session.*` events. A future table-service session pool gets
 * its own registry rather than sharing this one — the two pools have
 * independent lifecycles. Keyed by `DriverIdentity` reference.
 */
export class SessionPoolRegistry {
	#sessions = new Map<DriverIdentity, SessionPoolState>()

	sessions(): ReadonlyMap<DriverIdentity, SessionPoolState> {
		return this.#sessions
	}

	driverClosed(driver: DriverIdentity): void {
		this.#sessions.delete(driver)
	}

	// `pool.opened` carries the authoritative max/min snapshot, so we replace
	// any state from a prior pool generation on the same driver.
	poolOpened(driver: DriverIdentity, maxSize: number, minSize: number): void {
		this.#sessions.set(driver, { ...EMPTY, maxSize, minSize })
	}

	poolClosed(driver: DriverIdentity): void {
		this.#sessions.delete(driver)
	}

	createStarted(driver: DriverIdentity): void {
		this.#get(driver).creating += 1
	}

	createEnded(driver: DriverIdentity): void {
		let s = this.#get(driver)
		s.creating = Math.max(0, s.creating - 1)
	}

	created(driver: DriverIdentity): void {
		this.#get(driver).total += 1
	}

	closed(driver: DriverIdentity): void {
		let s = this.#get(driver)
		s.total = Math.max(0, s.total - 1)
	}

	acquired(driver: DriverIdentity): void {
		this.#get(driver).acquired += 1
	}

	released(driver: DriverIdentity): void {
		let s = this.#get(driver)
		s.acquired = Math.max(0, s.acquired - 1)
	}

	waiterEnqueued(driver: DriverIdentity): void {
		this.#get(driver).waiters += 1
	}

	waiterDequeued(driver: DriverIdentity): void {
		let s = this.#get(driver)
		s.waiters = Math.max(0, s.waiters - 1)
	}

	#get(driver: DriverIdentity): SessionPoolState {
		let s = this.#sessions.get(driver)
		if (!s) {
			s = { ...EMPTY }
			this.#sessions.set(driver, s)
		}
		return s
	}
}
