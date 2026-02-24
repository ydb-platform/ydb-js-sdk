/**
 * OpenTelemetry semantic convention constants for YDB database spans.
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/
 */
export declare const DB_SYSTEM = 'ydb'
export declare const SPAN_NAMES: {
	readonly CreateSession: 'ydb.CreateSession'
	readonly ExecuteQuery: 'ydb.ExecuteQuery'
	readonly Commit: 'ydb.Commit'
	readonly Rollback: 'ydb.Rollback'
}
//# sourceMappingURL=constants.d.ts.map
