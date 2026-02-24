/**
 * OpenTelemetry semantic convention constants for YDB database spans.
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/
 */

export const DB_SYSTEM = 'ydb'

export const SPAN_NAMES = {
	CreateSession: 'ydb.CreateSession',
	ExecuteQuery: 'ydb.ExecuteQuery',
	Commit: 'ydb.Commit',
	Rollback: 'ydb.Rollback',
} as const
