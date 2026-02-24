/**
 * Extracts db.response.status_code and error.type from an error.
 * Values are aligned with YDB status codes and error naming.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/#errorstype
 */
export declare function recordErrorAttributes(error: unknown): {
	'db.response.status_code': string
	'error.type': string
}
//# sourceMappingURL=error.d.ts.map
