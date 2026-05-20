import * as assert from 'node:assert/strict'

import { test } from 'vitest'

import * as root from './index.ts'
import { createDrizzle, drizzle } from './ydb/createDrizzle.ts'
import { YdbDriver } from './ydb/driver.ts'
import {
	YdbAuthenticationError,
	YdbCancelledQueryError,
	YdbOverloadedQueryError,
	YdbQueryExecutionError,
	YdbRetryableQueryError,
	YdbTimeoutQueryError,
	YdbUnavailableQueryError,
	YdbUniqueConstraintViolationError,
} from './ydb/errors.ts'
import { createMany, createOne, relations } from 'drizzle-orm'

let expectedRootExports = [
	'YdbAuthenticationError',
	'YdbCancelledQueryError',
	'YdbDriver',
	'YdbOverloadedQueryError',
	'YdbQueryExecutionError',
	'YdbRetryableQueryError',
	'YdbTimeoutQueryError',
	'YdbUnavailableQueryError',
	'YdbUniqueConstraintViolationError',
	'createDrizzle',
	'drizzle',
	'many',
	'one',
	'relations',
] as const

test('root entrypoint exposes exactly the bootstrap surface', () => {
	assert.deepEqual(Object.keys(root).sort(), [...expectedRootExports])
})

test('root re-exports are the canonical symbols', () => {
	assert.equal(root.createDrizzle, createDrizzle)
	assert.equal(root.drizzle, drizzle)
	assert.equal(root.YdbDriver, YdbDriver)
	assert.equal(root.YdbAuthenticationError, YdbAuthenticationError)
	assert.equal(root.YdbCancelledQueryError, YdbCancelledQueryError)
	assert.equal(root.YdbOverloadedQueryError, YdbOverloadedQueryError)
	assert.equal(root.YdbQueryExecutionError, YdbQueryExecutionError)
	assert.equal(root.YdbRetryableQueryError, YdbRetryableQueryError)
	assert.equal(root.YdbTimeoutQueryError, YdbTimeoutQueryError)
	assert.equal(root.YdbUnavailableQueryError, YdbUnavailableQueryError)
	assert.equal(root.YdbUniqueConstraintViolationError, YdbUniqueConstraintViolationError)
	assert.equal(root.relations, relations)
	assert.equal(root.many, createMany)
	assert.equal(root.one, createOne)
})
