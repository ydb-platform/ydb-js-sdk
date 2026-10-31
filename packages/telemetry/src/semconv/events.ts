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

// Bridge (2DC) pile roster change, recorded on the discovery span the round
// fires within.
export let EVENT_YDB_DRIVER_PILE_CHANGED = 'ydb.driver.pile.changed'

export let ATTR_YDB_DRIVER_PILE_PRIMARY_BEFORE = 'ydb.driver.pile.primary_before'
export let ATTR_YDB_DRIVER_PILE_PRIMARY_AFTER = 'ydb.driver.pile.primary_after'
// Full rosters as `name:STATUS` strings. The producer fires this channel on ANY
// roster or status difference, not just a primary handover, so the scalar
// primary_before/after alone would describe nothing for a status-only change
// (and nothing at all when no pile is PRIMARY — the split-brain window this
// event exists to trace). Span-event attributes are not cardinality-budgeted.
export let ATTR_YDB_DRIVER_PILE_BEFORE = 'ydb.driver.pile.before'
export let ATTR_YDB_DRIVER_PILE_AFTER = 'ydb.driver.pile.after'
