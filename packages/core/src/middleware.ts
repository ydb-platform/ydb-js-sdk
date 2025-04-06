import { isAbortError } from 'abort-controller-x';
import { ClientError, type ClientMiddleware } from "nice-grpc"

import { dbg } from "./dbg.js"

export const debug: ClientMiddleware = async function* (call, options) {
	let hasError = false
	try {
		return yield* call.next(call.request, options)
	} catch (error) {
		hasError = true
		if (error instanceof ClientError) {
			dbg.extend('grpc')('%s', error.message)
		} else if (isAbortError(error)) {
			dbg.extend('grpc')('%s %s: %s', call.method.path, 'CANCELLED', error.message)
		} else {
			dbg.extend('grpc')('%s %s: %s', call.method.path, 'UNKNOWN', error)
		}

		throw error
	} finally {
		if (!hasError) {
			dbg.extend('grpc')('%s %s', call.method.path, 'OK')
		}
	}
}
