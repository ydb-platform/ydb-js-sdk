/**
 * OpenTelemetry semantic convention constants for YDB database spans.
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/
 */
/** Database system identifier for YDB */
export declare const DB_SYSTEM = 'ydb'
/** Span names for QueryService operations */
export declare const SPAN_NAMES: {
	readonly CreateSession: 'ydb.CreateSession'
	readonly ExecuteQuery: 'ydb.ExecuteQuery'
	readonly Commit: 'ydb.Commit'
	readonly Rollback: 'ydb.Rollback'
}
//# sourceMappingURL=constants.d.ts.map
