// Metric instrument names and tag keys that exist only on metrics.
// Tag keys shared with spans are declared in `spans.ts` / `common.ts` to
// keep both pipelines pointed at one string.

export let METRIC_DB_CLIENT_OPERATION_DURATION = 'db.client.operation.duration'

export let METRIC_YDB_DRIVER_CONNECTION_PESSIMIZATIONS = 'ydb.driver.connection.pessimizations'

export let METRIC_YDB_QUERY_SESSION_CREATE_DURATION = 'ydb.query.session.create.duration'
export let METRIC_YDB_QUERY_SESSION_ACQUIRE_DURATION = 'ydb.query.session.acquire.duration'
export let METRIC_YDB_QUERY_SESSION_ACQUIRE_PENDING = 'ydb.query.session.acquire.pending'
export let METRIC_YDB_QUERY_SESSION_ACQUIRE_FAILURES = 'ydb.query.session.acquire.failures'
export let METRIC_YDB_QUERY_SESSION_CLOSED = 'ydb.query.session.closed'
export let METRIC_YDB_QUERY_SESSION_COUNT = 'ydb.query.session.count'
export let METRIC_YDB_QUERY_SESSION_MAX = 'ydb.query.session.max'
export let METRIC_YDB_QUERY_SESSION_MIN = 'ydb.query.session.min'
export let METRIC_YDB_DRIVER_CONNECTION_COUNT = 'ydb.driver.connection.count'

export let METRIC_YDB_AUTH_TOKEN_FETCH_DURATION = 'ydb.auth.token.fetch.duration'
export let METRIC_YDB_AUTH_TOKEN_FETCH_FAILURES = 'ydb.auth.token.fetch.failures'
export let METRIC_YDB_AUTH_TOKEN_REFRESHES = 'ydb.auth.token.refreshes'
export let METRIC_YDB_AUTH_TOKEN_EXPIRATIONS = 'ydb.auth.token.expirations'

export let METRIC_YDB_RETRY_ATTEMPTS = 'ydb.retry.attempts'
export let METRIC_YDB_RETRY_DURATION = 'ydb.retry.duration'

export let ATTR_YDB_RETRY_OUTCOME = 'ydb.retry.outcome'

export let ATTR_YDB_CONNECTION_STATE = 'ydb.connection.state'
export let ATTR_YDB_SESSION_STATE = 'ydb.session.state'
