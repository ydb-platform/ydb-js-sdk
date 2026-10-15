import { expect, test } from 'vitest'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { CommitError, YDBError } from '@ydbjs/error'
import { Metadata, status as Status } from '@grpc/grpc-js'

import { defaultRetryConfig, isRetryableError } from './index.js'
import type { RetryStrategy } from './strategy.js'

// Tests for isRetryableError function
test('ServiceError with ABORTED is retryable', () => {
	let error = Object.assign(new Error('test details'), {
		code: Status.ABORTED,
		details: 'test details',
		metadata: new Metadata(),
	})
	expect(isRetryableError(error)).toBe(true)
})

test('ServiceError with INTERNAL is retryable', () => {
	let error = Object.assign(new Error('test details'), {
		code: Status.INTERNAL,
		details: 'test details',
		metadata: new Metadata(),
	})
	expect(isRetryableError(error)).toBe(true)
})

test('ServiceError with RESOURCE_EXHAUSTED is retryable', () => {
	let error = Object.assign(new Error('test details'), {
		code: Status.RESOURCE_EXHAUSTED,
		details: 'test details',
		metadata: new Metadata(),
	})
	expect(isRetryableError(error)).toBe(true)
})

test('ServiceError with UNAVAILABLE is retryable only for idempotent operations', () => {
	let error = Object.assign(new Error('test details'), {
		code: Status.UNAVAILABLE,
		details: 'test details',
		metadata: new Metadata(),
	})
	expect(isRetryableError(error, false)).toBe(false)
	expect(isRetryableError(error, true)).toBe(true)
})

test('ServiceError with other statuses is not retryable', () => {
	let error = Object.assign(new Error('test details'), {
		code: Status.NOT_FOUND,
		details: 'test details',
		metadata: new Metadata(),
	})
	expect(isRetryableError(error)).toBe(false)
	expect(isRetryableError(error, true)).toBe(false)
})

test('YDBError with BAD_SESSION is retryable', () => {
	let error = new YDBError(StatusIds_StatusCode.BAD_SESSION, [])
	expect(isRetryableError(error)).toBe(true)
})

test('YDBError with OVERLOADED is retryable', () => {
	let error = new YDBError(StatusIds_StatusCode.OVERLOADED, [])
	expect(isRetryableError(error)).toBe(true)
})

test('YDBError with UNAVAILABLE is retryable', () => {
	let error = new YDBError(StatusIds_StatusCode.UNAVAILABLE, [])
	expect(isRetryableError(error)).toBe(true)
})

test('YDBError with SESSION_EXPIRED is conditionally retryable', () => {
	let error = new YDBError(StatusIds_StatusCode.SESSION_EXPIRED, [])
	expect(isRetryableError(error, false)).toBe(false)
	expect(isRetryableError(error, true)).toBe(true)
})

test('YDBError with TIMEOUT is conditionally retryable', () => {
	let error = new YDBError(StatusIds_StatusCode.TIMEOUT, [])
	expect(isRetryableError(error, false)).toBe(false)
	expect(isRetryableError(error, true)).toBe(true)
})

test('YDBError with UNDETERMINED is conditionally retryable', () => {
	let error = new YDBError(StatusIds_StatusCode.UNDETERMINED, [])
	expect(isRetryableError(error, false)).toBe(false)
	expect(isRetryableError(error, true)).toBe(true)
})

test('YDBError with non-retryable code is not retryable', () => {
	let error = new YDBError(StatusIds_StatusCode.NOT_FOUND, [])
	expect(isRetryableError(error)).toBe(false)
	expect(isRetryableError(error, true)).toBe(false)
})

test('CommitError retryability depends on its retryable method', () => {
	let retryableYDBError = new YDBError(StatusIds_StatusCode.ABORTED, [])
	let retryableCommitError = new CommitError('Retryable commit error', retryableYDBError)

	let conditionalYDBError = new YDBError(StatusIds_StatusCode.TIMEOUT, [])
	let conditionalCommitError = new CommitError('Conditional commit error', conditionalYDBError)

	let nonRetryableYDBError = new YDBError(StatusIds_StatusCode.NOT_FOUND, [])
	let nonRetryableCommitError = new CommitError(
		'Non-retryable commit error',
		nonRetryableYDBError
	)

	expect(isRetryableError(retryableCommitError, false)).toBe(true)
	expect(isRetryableError(retryableCommitError, true)).toBe(true)

	expect(isRetryableError(conditionalCommitError, false)).toBe(false)
	expect(isRetryableError(conditionalCommitError, true)).toBe(true)

	expect(isRetryableError(nonRetryableCommitError, false)).toBe(false)
	expect(isRetryableError(nonRetryableCommitError, true)).toBe(false)
})

test('Unknown error types are not retryable', () => {
	let standardError = new Error('Standard error')
	let customError = { message: 'Custom error object' }
	let stringError = 'String error'
	let nullError = null

	expect(isRetryableError(standardError)).toBe(false)
	expect(isRetryableError(customError)).toBe(false)
	expect(isRetryableError(stringError)).toBe(false)
	expect(isRetryableError(nullError)).toBe(false)
})

// Tests for defaultRetryConfig strategy behavior
test('defaultRetryConfig uses fixed(0) for BAD_SESSION', () => {
	let error = new YDBError(StatusIds_StatusCode.BAD_SESSION, [])
	let ctx = { attempt: 2, error }

	let strategy = defaultRetryConfig.strategy as RetryStrategy
	let delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(0)
})

test('defaultRetryConfig uses fixed(0) for SESSION_EXPIRED', () => {
	let error = new YDBError(StatusIds_StatusCode.SESSION_EXPIRED, [])
	let ctx = { attempt: 2, error }

	let strategy = defaultRetryConfig.strategy as RetryStrategy
	let delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(0)
})

test('defaultRetryConfig uses fixed(0) for ServiceError ABORTED', () => {
	let error = Object.assign(new Error('test details'), {
		code: Status.ABORTED,
		details: 'test details',
		metadata: new Metadata(),
	})
	let ctx = { attempt: 2, error }

	let strategy = defaultRetryConfig.strategy as RetryStrategy
	let delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(0)
})

test('defaultRetryConfig uses exponential(1000) for OVERLOADED', () => {
	let error = new YDBError(StatusIds_StatusCode.OVERLOADED, [])
	let ctx = { attempt: 0, error }

	let strategy = defaultRetryConfig.strategy as RetryStrategy
	let delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(1000)

	ctx = { attempt: 1, error }
	delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(2000)
})

test('defaultRetryConfig uses exponential(1000) for ServiceError RESOURCE_EXHAUSTED', () => {
	let error = Object.assign(new Error('test details'), {
		code: Status.RESOURCE_EXHAUSTED,
		details: 'test details',
		metadata: new Metadata(),
	})
	let ctx = { attempt: 0, error }

	let strategy = defaultRetryConfig.strategy as RetryStrategy
	let delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(1000)

	ctx = { attempt: 1, error }
	delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(2000)
})

test('defaultRetryConfig uses exponential(10) for other errors', () => {
	let error = new Error('Generic error')
	let ctx = { attempt: 0, error }

	let strategy = defaultRetryConfig.strategy as RetryStrategy
	let delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(10)

	ctx = { attempt: 1, error }
	delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(20)

	ctx = { attempt: 2, error }
	delay = strategy(ctx, defaultRetryConfig)
	expect(delay).toBe(40)
})

test('defaultRetryConfig has correct default values', () => {
	expect(defaultRetryConfig.budget).toBe(Infinity)
	expect(typeof defaultRetryConfig.retry).toBe('function')
	expect(typeof defaultRetryConfig.strategy).toBe('function')
})

test('defaultRetryConfig retry function uses isRetryableError', () => {
	let retryableError = Object.assign(new Error('test details'), {
		code: Status.ABORTED,
		details: 'test details',
		metadata: new Metadata(),
	})
	let nonRetryableError = new Error('Generic error')

	let retryFn = defaultRetryConfig.retry as (error: unknown, idempotent: boolean) => boolean
	expect(retryFn(retryableError, false)).toBe(true)
	expect(retryFn(nonRetryableError, false)).toBe(false)
})
