import { expect, test } from 'vitest'

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
	expect(Object.keys(root).sort()).toEqual([...expectedRootExports])
})

test('root re-exports are the canonical symbols', () => {
	expect(root.createDrizzle).toBe(createDrizzle)
	expect(root.drizzle).toBe(drizzle)
	expect(root.YdbDriver).toBe(YdbDriver)
	expect(root.YdbAuthenticationError).toBe(YdbAuthenticationError)
	expect(root.YdbCancelledQueryError).toBe(YdbCancelledQueryError)
	expect(root.YdbOverloadedQueryError).toBe(YdbOverloadedQueryError)
	expect(root.YdbQueryExecutionError).toBe(YdbQueryExecutionError)
	expect(root.YdbRetryableQueryError).toBe(YdbRetryableQueryError)
	expect(root.YdbTimeoutQueryError).toBe(YdbTimeoutQueryError)
	expect(root.YdbUnavailableQueryError).toBe(YdbUnavailableQueryError)
	expect(root.YdbUniqueConstraintViolationError).toBe(YdbUniqueConstraintViolationError)
	expect(root.relations).toBe(relations)
	expect(root.many).toBe(createMany)
	expect(root.one).toBe(createOne)
})
