import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { createQueryServiceClient, type QueryServiceClient } from "@ydbjs/api/query";
import type { Driver } from "@ydbjs/core";

import { Session, SessionState } from "./session.js";

export interface SessionPoolOptions {
	minSessions?: number
	maxSessions?: number

	[key: string]: any;
}

const defaultSessionPoolOptions: SessionPoolOptions = {
	maxSessions: 50,
}

export class WIP_SessionPool {
	#driver: Driver
	#client: QueryServiceClient
	#options: SessionPoolOptions = {}

	#sessions: Session[] = []
	#waitingQueue: Array<(session: Session) => void> = []

	constructor(driver: Driver, options: SessionPoolOptions = defaultSessionPoolOptions) {
		this.#driver = driver
		this.#client = createQueryServiceClient(driver)

		for (let key in defaultSessionPoolOptions) {
			this.#options[key] = options[key] ?? defaultSessionPoolOptions[key]
		}
	}

	async acquire(signal?: AbortSignal): Promise<Session> {
		return new Promise(async (resolve) => {
			let availableSession = this.#sessions.find(session => session.state === SessionState.IDLE);

			if (availableSession) {
				let response = this.#client.attachSession({ sessionId: availableSession.id });
				let r = await response[Symbol.asyncIterator]().next()
				if (r.done) {
					throw new Error("Failed to attach session.")
					// TODO: DELETE SESSION
				}

				if (r.value.status !== StatusIds_StatusCode.SUCCESS) {
					throw new Error("Failed to attach session.")
					// TODO: DELETE SESSION
				}

				new Promise(async (resolve, reject) => {
					try {
						for await (let state of response) {
							if (state.status !== StatusIds_StatusCode.SUCCESS) {
								// TODO: delete session
							}
						}
					} catch (e) {
						// TODO: DELETE SESSION
					}
				})

				availableSession.bind(this.#driver.getConnection());
				resolve(availableSession);
			} else if (this.#options.maxSessions && this.#sessions.length < this.#options.maxSessions) {
				// Build a queue for session creation.
				// A session needs to be created in any case, even if a timeout was set or an abort occurred.
				let response = await this.#client.createSession({})
				if (response.status !== StatusIds_StatusCode.SUCCESS) {
					// We can retry while waiting for the promise
					throw new Error("Failed to create session.")
				}

				let newSession = new Session(response.sessionId);
				newSession.bind(this.#driver.getConnection(Number(response.nodeId)));
				this.#sessions.push(newSession);
				resolve(newSession);
			} else {
				this.#waitingQueue.push(resolve);

				// Remove from queue if abort occurs.
				signal?.addEventListener("abort", () => {
					let index = this.#waitingQueue.indexOf(resolve);
					if (index !== -1) {
						this.#waitingQueue.splice(index, 1);
					}
				})
			}
		});
	}

	async release(session: Session): Promise<void> {
		session.release();
		if (this.#waitingQueue.length > 0) {
			// Don't pass the session if abort happened in acquire.

			let nextRequest = this.#waitingQueue.shift();
			if (nextRequest) {
				session.bind(this.#driver.getConnection());
				nextRequest(session);
			}
		}
	}

	async delete(session: Session): Promise<void> {
		let index = this.#sessions.indexOf(session);
		if (index === -1) {
			throw new Error("Session not found.");
		}

		let response = await this.#client.deleteSession({ sessionId: session.id });
		if (response.status !== StatusIds_StatusCode.SUCCESS) {
			throw new Error("Failed to delete session.");
		}

		this.#sessions.splice(index, 1);
		// Create a session if the total number is less than the maximum and there are requests in the queue.
	}

	async close(): Promise<void> { }
}

// Pool -> Session -> ExecuteQuery
