import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { isRetryableError, isRetryableStreamError } from '@ydbjs/retry'
import { ClientError, Status } from 'nice-grpc'

export function isRetryableTopicError(error: unknown, retryOnSchemeError = false): boolean {
	if (error === undefined || error === null) {
		return true
	}

	// Changing streams cannot make an oversized frame fit; quota exhaustion can recover.
	if (error instanceof ClientError) {
		if (error.code === Status.RESOURCE_EXHAUSTED && /larger than/i.test(error.details)) {
			return false
		}
		if (error.code === Status.DEADLINE_EXCEEDED) {
			return true
		}
	}

	if (
		retryOnSchemeError &&
		error instanceof YDBError &&
		error.code === StatusIds_StatusCode.SCHEME_ERROR
	) {
		return true
	}

	// Sequence numbers deduplicate writes; consumer offsets make read/commit replay safe.
	return isRetryableStreamError(error) || isRetryableError(error, true)
}
