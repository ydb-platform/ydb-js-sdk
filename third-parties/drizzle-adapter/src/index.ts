// Bootstrap surface: how you connect, what `drizzle()` returns, and the error
// classes you catch. For schemas, YQL expressions, and migrations import from
// `@ydbjs/drizzle-adapter/schema`, `/sql`, and `/migrator` respectively.

export {
	createDrizzle,
	drizzle,
	type YdbDrizzleConfig,
	type YdbDrizzleDatabase,
	type YdbDrizzleOptions,
} from './ydb/createDrizzle.js'
export {
	YdbDriver,
	type YdbDriverOptions,
	type YdbExecuteOptions,
	type YdbExecutor,
	type YdbQueryMeta,
	type YdbQueryResult,
	type YdbRemoteCallback,
	type YdbTransactionalExecutor,
	type YdbTransactionConfig,
} from './ydb/driver.js'
export {
	YdbAuthenticationError,
	YdbCancelledQueryError,
	YdbOverloadedQueryError,
	YdbQueryExecutionError,
	YdbRetryableQueryError,
	YdbTimeoutQueryError,
	YdbUnavailableQueryError,
	YdbUniqueConstraintViolationError,
	type YdbQueryErrorDetails,
	type YdbQueryErrorKind,
} from './ydb/errors.js'
export type { YdbTransactionScope } from './ydb-core/db.js'
// Relations are re-exported so schemas declared with
// `@ydbjs/drizzle-adapter/schema` can stand up the relations API from a single
// install without depending on `drizzle-orm` directly.
export { createMany as many, createOne as one, relations } from 'drizzle-orm'
