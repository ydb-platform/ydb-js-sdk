/**
 * OpenTelemetry semantic convention constants for YDB database spans.
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/
 */
/** Database system identifier for YDB */
export const DB_SYSTEM = 'ydb'
/** Span names for QueryService operations */
export const SPAN_NAMES = {
	CreateSession: 'ydb.CreateSession',
	ExecuteQuery: 'ydb.ExecuteQuery',
	Commit: 'ydb.Commit',
	Rollback: 'ydb.Rollback',
}
//# sourceMappingURL=constants.js.map
