import type { Connection } from "@ydbjs/core/connection";

export enum SessionState {
	NEW = 0,
	IDLE = 1,
	BUSY = 2,
}

export class Session {
	#state: SessionState = SessionState.NEW
	#connection: Connection | null = null

	readonly id: string

	constructor(id: string) {
		this.id = id
	}

	get state(): SessionState {
		return this.#state
	}

	get connection(): Connection | null {
		return this.#connection
	}

	bind(connection: Connection): this {
		if (this.#state === SessionState.BUSY) {
			throw new Error("Session is already in use.")
		}

		this.#state = SessionState.BUSY
		this.#connection = connection

		return this
	}

	release(): void {
		this.#connection = null
		this.#state = SessionState.IDLE
	}
}
