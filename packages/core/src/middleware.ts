import { isAbortError } from 'abort-controller-x';
import { ClientError, type ClientMiddleware } from "nice-grpc"

import { dbg } from "./dbg.js"

let log = dbg.extend('grpc')

export const debug: ClientMiddleware = async function* (call, options) {
	let hasError = false
	try {
		return yield* call.next(call.request, options)
	} catch (error) {
		hasError = true
		if (error instanceof ClientError) {
			log('%s', error.message)
		} else if (isAbortError(error)) {
			log('%s %s: %s', call.method.path, 'CANCELLED', error.message)
		} else {
			log('%s %s: %s', call.method.path, 'UNKNOWN', error)
		}

		throw error
	} finally {
		if (!hasError) {
			log('%s %s', call.method.path, 'OK')
		}
	}
}
