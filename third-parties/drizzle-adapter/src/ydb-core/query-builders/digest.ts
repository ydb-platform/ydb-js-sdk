import { SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'

// Each helper wraps a `Digest::*` UDF and strips the `Optional` that bound
// parameters introduce — without `Unwrap` the result is `Optional<T>` and
// won't fit a `NOT NULL` column (the common case when the hash is the leading
// component of a composite primary key for shard distribution).

// `Digest::NumericHash(Uint64) -> Uint64` is YDB's canonical way to derive a
// uniformly distributed shard prefix from a numeric id, paired with the natural
// id as a composite primary key so monotonic ids don't hot-spot one tablet.
export function numericHash(value: SQLWrapper | number | bigint): SQL<bigint> {
	return yql`Unwrap(Digest::NumericHash(CAST(${value} AS Uint64)))`
}

// `Digest::XXH3(String) -> Uint64` — fast 64-bit hash for string-keyed rows
// (emails, slugs, uuid-as-string). Same shard-prefix role as numericHash but
// for non-numeric natural keys.
export function xxHash(value: SQLWrapper | string | Uint8Array): SQL<bigint> {
	return yql`Unwrap(Digest::XXH3(CAST(${value} AS String)))`
}

// `Digest::Crc32c(String) -> Uint32` — cheaper 32-bit shard prefix when 32
// bits of entropy are enough.
export function crc32c(value: SQLWrapper | string | Uint8Array): SQL<number> {
	return yql`Unwrap(Digest::Crc32c(CAST(${value} AS String)))`
}

// `Digest::Crc64(String, [Init:Uint64?]) -> Uint64` — 64-bit CRC alternative
// to XXH3; `init` seeds the polynomial when chaining chunks.
export function crc64(
	value: SQLWrapper | string | Uint8Array,
	init?: SQLWrapper | number | bigint
): SQL<bigint> {
	if (init === undefined) {
		return yql`Unwrap(Digest::Crc64(CAST(${value} AS String)))`
	}
	return yql`Unwrap(Digest::Crc64(CAST(${value} AS String), CAST(${init} AS Uint64)))`
}
