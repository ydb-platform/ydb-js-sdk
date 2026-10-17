import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { Metadata, status as Status } from '@grpc/grpc-js'
import { MessageSizeError, RpcError } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import { isRetryableTopicError } from './retry.ts'

test('reconnects live topic streams after a server deadline', () => {
	let error = Object.assign(new Error('Stream deadline expired'), {
		code: Status.DEADLINE_EXCEEDED,
		details: 'Stream deadline expired',
		metadata: new Metadata(),
	})
	expect(isRetryableTopicError(error)).toBe(true)
})

test('reconnects a reader after an indeterminate idempotent stream failure', () => {
	for (let status of [
		StatusIds_StatusCode.SESSION_EXPIRED,
		StatusIds_StatusCode.TIMEOUT,
		StatusIds_StatusCode.UNDETERMINED,
	]) {
		expect(isRetryableTopicError(new YDBError(status, []))).toBe(true)
	}
})

test.for(['request', 'response'] as const)('does not retry a local %s size limit', (direction) => {
	expect(isRetryableTopicError(new MessageSizeError(direction, 1024))).toBe(false)
	expect(isRetryableTopicError(new RpcError(Status.RESOURCE_EXHAUSTED, 'Rate limit'))).toBe(true)
})
