import { YDBError } from '@ydbjs/error'
/**
 * Extracts db.response.status_code and error.type from an error.
 * Values are aligned with YDB status codes and error naming.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/#errorstype
 */
export function recordErrorAttributes(error) {
	if (error instanceof YDBError) {
		const statusCode = YDBError.codes[error.code]
		return {
			'db.response.status_code': statusCode ?? 'UNKNOWN',
			'error.type': statusCode ?? 'UNKNOWN',
		}
	}
	if (error instanceof Error && 'name' in error) {
		const name = error.name
		if (name === 'AbortError' || name.includes('Abort')) {
			return {
				'db.response.status_code': 'CANCELLED',
				'error.type': 'CANCELLED',
			}
		}
		if (name === 'TimeoutError' || name.includes('Timeout')) {
			return {
				'db.response.status_code': 'TIMEOUT',
				'error.type': 'TIMEOUT',
			}
		}
		if (name === 'ClientError') {
			return {
				'db.response.status_code': 'TRANSPORT_ERROR',
				'error.type': 'TRANSPORT_ERROR',
			}
		}
	}
	return {
		'db.response.status_code': 'UNKNOWN',
		'error.type': 'UNKNOWN',
	}
}
//# sourceMappingURL=error.js.map
