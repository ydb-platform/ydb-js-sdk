// ── Semaphore ─────────────────────────────────────────────────────────────────

export class TryAcquireMissError extends Error {
	constructor() {
		super('Try-acquire miss: semaphore has no available tokens')
		this.name = 'TryAcquireMissError'
	}
}

export let isTryAcquireMiss = function isTryAcquireMiss(error: unknown): boolean {
	return error instanceof TryAcquireMissError
}

export class LeaseReleasedError extends Error {
	constructor() {
		super('Semaphore lease released')
		this.name = 'LeaseReleasedError'
	}
}

// ── Session ───────────────────────────────────────────────────────────────────

export class SessionClosedError extends Error {
	constructor(message = 'Session closed') {
		super(message)
		this.name = 'SessionClosedError'
	}
}

export class SessionExpiredError extends Error {
	constructor(message = 'Session expired') {
		super(message)
		this.name = 'SessionExpiredError'
	}
}

// ── Election ──────────────────────────────────────────────────────────────────

export class LeaderChangedError extends Error {
	constructor() {
		super('Leader changed')
		this.name = 'LeaderChangedError'
	}
}

export class ObservationEndedError extends Error {
	constructor() {
		super('Election observation ended')
		this.name = 'ObservationEndedError'
	}
}
