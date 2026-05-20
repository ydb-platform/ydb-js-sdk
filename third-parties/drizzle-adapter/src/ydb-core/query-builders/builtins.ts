import { SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'

// Current UTC clock readings. These are constant within a query — every call
// site receives the same value — so they're safe to use multiple times in one
// statement without diverging.
export function currentUtcDate(): SQL<Date> {
	return yql`CurrentUtcDate()`
}

export function currentUtcDatetime(): SQL<Date> {
	return yql`CurrentUtcDatetime()`
}

export function currentUtcTimestamp(): SQL<Date> {
	return yql`CurrentUtcTimestamp()`
}

function joinKeys(keys: readonly SQLWrapper[]): SQL {
	return yql.join(
		keys.map((key) => yql`${key}`),
		yql`, `
	)
}

// `Random()` / `RandomNumber()` / `RandomUuid()` are evaluated once per call
// site per query unless they receive cache keys — meaning the no-arg form
// returns the *same* value for every row, which is almost never what you want.
// Requiring at least one key (typically a column reference) forces per-row
// re-evaluation and prevents the silent foot-gun.
export function random(key: SQLWrapper, ...rest: SQLWrapper[]): SQL<number> {
	return yql`Random(${joinKeys([key, ...rest])})`
}

export function randomNumber(key: SQLWrapper, ...rest: SQLWrapper[]): SQL<bigint> {
	return yql`RandomNumber(${joinKeys([key, ...rest])})`
}

export function randomUuid(key: SQLWrapper, ...rest: SQLWrapper[]): SQL<string> {
	return yql`RandomUuid(${joinKeys([key, ...rest])})`
}

// `Unwrap(value, [message])` strips an `Optional<T>` to `T`, failing the query
// with `message` (or a generic error) if the value is NULL. Useful any time a
// value is statically nullable but the destination column or expression is not.
export function unwrap<T>(value: SQLWrapper, message?: string): SQL<T> {
	if (message === undefined) {
		return yql`Unwrap(${value})`
	}
	return yql`Unwrap(${value}, ${message})`
}

// `MAX_OF(a, b, ...)` / `MIN_OF(a, b, ...)` are N-ary scalar extrema across
// the arguments (not aggregates). Standard SQL `GREATEST`/`LEAST` aren't part
// of YQL; this is the idiomatic replacement.
export function maxOf<T>(
	first: SQLWrapper | T,
	second: SQLWrapper | T,
	...rest: Array<SQLWrapper | T>
): SQL<T> {
	let args = [first, second, ...rest].map((arg) => yql`${arg}`)
	return yql`MAX_OF(${yql.join(args, yql`, `)})`
}

export function minOf<T>(
	first: SQLWrapper | T,
	second: SQLWrapper | T,
	...rest: Array<SQLWrapper | T>
): SQL<T> {
	let args = [first, second, ...rest].map((arg) => yql`${arg}`)
	return yql`MIN_OF(${yql.join(args, yql`, `)})`
}
