import { SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'

// `Digest::NumericHash(Uint64) -> Uint64` is YDB's canonical way to derive a
// uniformly distributed shard prefix from a numeric id, used as the first
// column of a composite primary key so monotonic ids don't hot-spot a single
// tablet. The `CAST(... AS Uint64)` matches the UDF's only signature, and the
// `Unwrap(...)` strips the `Optional` that bound parameters carry — without it,
// the result is `Optional<Uint64>` and won't fit a `NOT NULL Uint64` column.
export function numericHash(value: SQLWrapper | number | bigint): SQL {
	return yql`Unwrap(Digest::NumericHash(CAST(${value} AS Uint64)))`
}
