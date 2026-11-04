import { isRetryableError } from '@ydbjs/retry'

import { SessionAbortedError } from './session.js'

export function cancellationError(reason: unknown): unknown {
	if (!isRetryableError(reason, true) && !(reason instanceof SessionAbortedError)) return reason

	// Cancellation reasons must not become database failures in an enclosing retry scope.
	let error = new Error('Query operation cancelled.', { cause: reason })
	error.name = 'AbortError'
	return error
}
