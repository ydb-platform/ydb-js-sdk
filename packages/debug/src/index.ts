import type { Debugger } from 'debug'
import debug from 'debug'

/**
 * Debug categories used across YDB SDK
 */
export type YDBLogCategory =
	| 'api'        // API calls and responses
	| 'auth'       // Authentication and token management
	| 'grpc'       // gRPC client operations
	| 'driver'     // Driver lifecycle and connection management
	| 'discovery'  // Service discovery
	| 'session'    // Session management
	| 'query'      // Query execution
	| 'topic'      // Topic operations
	| 'tx'         // Transaction operations
	| 'retry'      // Retry logic
	| 'error'      // Error handling
	| 'perf'       // Performance metrics

/**
 * Color mapping for debug categories (following Playwright's approach)
 */
const debugColors: Record<YDBLogCategory, number> = {
	'api': 45,       // cyan
	'auth': 34,      // green
	'grpc': 33,      // blue
	'driver': 92,    // purple
	'discovery': 93, // bright yellow
	'session': 35,   // magenta
	'query': 36,     // cyan
	'topic': 94,     // bright blue
	'tx': 91,        // bright red
	'retry': 95,     // bright magenta
	'error': 160,    // red
	'perf': 32,      // green
}

/**
 * Centralized debug logger for YDB SDK (inspired by Playwright's DebugLogger)
 */
export class YDBDebugLogger {
	private debuggers = new Map<string, Debugger>()

	/**
	 * Create or get a debugger for a specific category and subcategory
	 */
	private getDebugger(category: YDBLogCategory, subcategory?: string): Debugger {
		let namespace = `ydbjs:${category}`
		if (subcategory) {
			namespace += `:${subcategory}`
		}

		let cachedDebugger = this.debuggers.get(namespace)
		if (!cachedDebugger) {
			cachedDebugger = debug(namespace)
				// Set color for the category
				; (cachedDebugger as any).color = debugColors[category] || 0
			this.debuggers.set(namespace, cachedDebugger)
		}

		return cachedDebugger
	}

	/**
	 * Log a message for a specific category
	 */
	log(category: YDBLogCategory, message: any, ...args: any[]): void
	log(category: YDBLogCategory, subcategory: string, message: any, ...args: any[]): void
	log(category: YDBLogCategory, subcategoryOrMessage: string | any, messageOrFirstArg?: any, ...restArgs: any[]): void {
		let subcategory: string | undefined
		let message: any
		let args: any[]

		if (typeof subcategoryOrMessage === 'string' && messageOrFirstArg !== undefined) {
			// Called with subcategory
			subcategory = subcategoryOrMessage
			message = messageOrFirstArg
			args = restArgs
		} else {
			// Called without subcategory
			message = subcategoryOrMessage
			args = messageOrFirstArg !== undefined ? [messageOrFirstArg, ...restArgs] : []
		}

		let dbg = this.getDebugger(category, subcategory)
		dbg(message, ...args)
	}

	/**
	 * Check if debugging is enabled for a category
	 */
	isEnabled(category: YDBLogCategory, subcategory?: string): boolean {
		let dbg = this.getDebugger(category, subcategory)
		return !!dbg.enabled
	}

	/**
	 * Create a scoped logger for a specific category and optional subcategory
	 */
	createLogger(category: YDBLogCategory, subcategory?: string) {
		let dbg = this.getDebugger(category, subcategory)

		return {
			/**
			 * Log a message
			 */
			log: (message: any, ...args: any[]) => dbg(message, ...args),

			/**
			 * Check if logging is enabled
			 */
			get enabled() {
				return !!dbg.enabled
			},

			/**
			 * Create a sub-logger with additional subcategory
			 */
			extend: (subname: string) => {
				let extendedCategory = subcategory ? `${subcategory}:${subname}` : subname
				return this.createLogger(category, extendedCategory)
			}
		}
	}
}

/**
 * Global debug logger instance
 */
export let ydbLogger = new YDBDebugLogger()

/**
 * Convenience functions for common logging patterns
 */
export let loggers = {
	api: ydbLogger.createLogger('api'),
	auth: ydbLogger.createLogger('auth'),
	grpc: ydbLogger.createLogger('grpc'),
	driver: ydbLogger.createLogger('driver'),
	discovery: ydbLogger.createLogger('discovery'),
	session: ydbLogger.createLogger('session'),
	query: ydbLogger.createLogger('query'),
	topic: ydbLogger.createLogger('topic'),
	tx: ydbLogger.createLogger('tx'),
	retry: ydbLogger.createLogger('retry'),
	error: ydbLogger.createLogger('error'),
	perf: ydbLogger.createLogger('perf'),
}
