// Point-in-time event names (first argument to `span.addEvent`) and the
// attribute keys those events carry. Namespaced by component so the driver's
// connection pool can't be confused with the query service's session pool.

export let EVENT_YDB_DRIVER_CONNECTION_ADDED = 'ydb.driver.connection.added'
export let EVENT_YDB_DRIVER_CONNECTION_PESSIMIZED = 'ydb.driver.connection.pessimized'
export let EVENT_YDB_DRIVER_CONNECTION_UNPESSIMIZED = 'ydb.driver.connection.unpessimized'
export let EVENT_YDB_DRIVER_CONNECTION_RETIRED = 'ydb.driver.connection.retired'
export let EVENT_YDB_DRIVER_CONNECTION_REMOVED = 'ydb.driver.connection.removed'

/**
 * @deprecated The endpoints engine has no fixed pessimization timer, so
 * `ydb:driver.connection.pessimized` no longer carries `until`. This attribute
 * is no longer emitted; kept only so existing dashboards don't fail to resolve
 * the symbol.
 * unix seconds
 */
export let ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_UNTIL =
	'ydb.driver.connection.pessimization.until'
/** seconds */
export let ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_DURATION =
	'ydb.driver.connection.pessimization.duration'

export let ATTR_YDB_DRIVER_CONNECTION_RETIRE_REASON = 'ydb.driver.connection.retire.reason'
export let ATTR_YDB_DRIVER_CONNECTION_REMOVE_REASON = 'ydb.driver.connection.remove.reason'
