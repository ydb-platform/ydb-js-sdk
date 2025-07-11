import type { Debugger } from 'debug'
import debug from 'debug'

/**
 * Debug categories used across YDB SDK
 */
export type YDBLogCategory =
	| 'auth'
	| 'driver'
	| 'error'
	| 'grpc'
	| 'query'
	| 'retry'
	| 'topic'
	| 'tx'

/**
 * Centralized debug logger for YDB SDK (inspired by Playwright's DebugLogger)
 */
export class YDBDebugLogger {
	#namespace: string
	#debuggers = new Map<string, Debugger>()

	constructor(namespace: string) {
		this.#namespace = namespace
	}

	get #debug(): Debugger {
		let ns = this.#namespace
		let cachedDebugger = this.#debuggers.get(ns)
		if (!cachedDebugger) {
			cachedDebugger = debug(ns)
			this.#debuggers.set(ns, cachedDebugger)
		}

		return cachedDebugger
	}

	log(message: any, ...args: any[]): void {
		this.#debug(message, ...args)
	}

	get enabled() {
		return !!this.#debug.enabled
	}

	extend(subname: string): YDBDebugLogger {
		let newNamespace = `${this.#namespace}:${subname}`
		return new YDBDebugLogger(newNamespace)
	}
}

/**
 * Convenience functions for common logging patterns
 */
// Sorted for consistency and maintainability
export let loggers = {
	auth: new YDBDebugLogger('ydbjs:auth'),
	driver: new YDBDebugLogger('ydbjs:driver'),
	error: new YDBDebugLogger('ydbjs:error'),
	grpc: new YDBDebugLogger('ydbjs:grpc'),
	query: new YDBDebugLogger('ydbjs:query'),
	retry: new YDBDebugLogger('ydbjs:retry'),
	topic: new YDBDebugLogger('ydbjs:topic'),
	tx: new YDBDebugLogger('ydbjs:tx'),
}
