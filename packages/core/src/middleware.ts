import { loggers } from '@ydbjs/debug'
import { ClientError, type ClientMiddleware } from 'nice-grpc'

let log = loggers.grpc

export const debug: ClientMiddleware = async function* (call, options) {
	let hasError = false
	try {
		return yield* call.next(call.request, options)
	} catch (error) {
		hasError = true
		if (error instanceof ClientError) {
			log.log('%s', error.message)
		} else if (error instanceof Error && error.name === 'AbortError') {
			log.log('%s %s: %s', call.method.path, 'CANCELLED', error.message)
		} else {
			log.log('%s %s: %s', call.method.path, 'UNKNOWN', error)
		}

		throw error
	} finally {
		if (!hasError) {
			log.log('%s %s', call.method.path, 'OK')
		}
	}
}

// Process-global middleware registry. Drivers compose registered entries
// into their gRPC client middleware chain at construction time. Used by
// `@ydbjs/telemetry` to install W3C trace context propagation without
// pulling `@opentelemetry/api` into `@ydbjs/core`.
//
// Timing: `addClientMiddleware()` must run **before** `new Driver(...)` for
// the middleware to apply. Matches OTel's NodeSDK.start() pattern — start
// instrumentation, then create application objects.
let registeredMiddlewares: ClientMiddleware[] = []

export function addClientMiddleware(mw: ClientMiddleware): Disposable {
	registeredMiddlewares.push(mw)

	return {
		[Symbol.dispose]() {
			let i = registeredMiddlewares.indexOf(mw)
			if (i >= 0) registeredMiddlewares.splice(i, 1)
		},
	}
}

export function getRegisteredClientMiddlewares(): readonly ClientMiddleware[] {
	return registeredMiddlewares
}
