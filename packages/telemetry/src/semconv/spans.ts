// Attribute keys for spans (and channel events that fold into the active
// span's attributes). Identifiers here MUST NOT cross over into metric
// tags — `session.id` / `transaction.id` would blow the cardinality budget.

export let ATTR_YDB_SESSION_ID = 'ydb.session.id'
export let ATTR_YDB_TRANSACTION_ID = 'ydb.transaction.id'

export let ATTR_YDB_ISOLATION = 'ydb.isolation'
export let ATTR_YDB_IDEMPOTENT = 'ydb.idempotent'
export let ATTR_YDB_AUTH_PROVIDER = 'ydb.auth.provider'

export let ATTR_YDB_SESSION_CLOSE_REASON = 'ydb.session.close.reason'
/** seconds */
export let ATTR_YDB_SESSION_UPTIME = 'ydb.session.uptime'

export let ATTR_YDB_DISCOVERY_ADDED_COUNT = 'ydb.discovery.added_count'
export let ATTR_YDB_DISCOVERY_REMOVED_COUNT = 'ydb.discovery.removed_count'
export let ATTR_YDB_DISCOVERY_TOTAL_COUNT = 'ydb.discovery.total_count'
/** seconds */
export let ATTR_YDB_DISCOVERY_DURATION = 'ydb.discovery.duration'
// Bridge (2DC) topology observed by a discovery round. Both are absent /
// dropped on a non-bridge cluster (empty self location, no PRIMARY pile).
export let ATTR_YDB_DISCOVERY_SELF_LOCATION = 'ydb.discovery.self_location'
export let ATTR_YDB_DISCOVERY_PRIMARY_PILE = 'ydb.discovery.primary_pile'

export let ATTR_YDB_RETRY_ATTEMPT = 'ydb.retry.attempt'
/** seconds — wait observed before this attempt started; `0` for attempt 1. */
export let ATTR_YDB_RETRY_BACKOFF = 'ydb.retry.backoff'
export let ATTR_YDB_RETRY_ATTEMPTS_TOTAL = 'ydb.retry.attempts_total'
/** seconds */
export let ATTR_YDB_RETRY_TOTAL_DURATION = 'ydb.retry.total_duration'
