/**
 * Escape a string for use inside a YQL JSON path literal (e.g. `'$.key'`).
 * JSON path keys cannot be passed as bound parameters in YQL, so escaping is
 * the only option. Not used for regular string values — those must be passed
 * as bound query parameters instead.
 */
export function escJsonPathKey(value: string): string {
	// Default YQL string literals use backslash escapes, not doubled quotes.
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\x00')
}
