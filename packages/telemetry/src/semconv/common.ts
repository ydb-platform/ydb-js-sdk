import type { Attributes } from '@opentelemetry/api'
import {
	ATTR_DB_RESPONSE_STATUS_CODE,
	ATTR_DB_SYSTEM_NAME,
	ATTR_ERROR_TYPE,
} from '@opentelemetry/semantic-conventions'

import type { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { ClientError } from 'nice-grpc'

// Keys used by BOTH pipelines live here. Span-only identifiers go in
// `spans.ts`; metric-only tag enums go in `metrics.ts`.

export type BaseAttributes = Attributes & { [ATTR_DB_SYSTEM_NAME]: 'ydb' }

export let BASE_ATTRIBUTES: BaseAttributes = { [ATTR_DB_SYSTEM_NAME]: 'ydb' }

// Dot-separated to match other YDB SDKs (ydb-dotnet, ydb-go); don't
// introduce snake_case variants of the same concept.
export let ATTR_YDB_NODE_ID = 'ydb.node.id'
export let ATTR_YDB_NODE_DC = 'ydb.node.dc'

/**
 * Error categories mirror ydb-dotnet:
 *   - `ydb_error`       — server returned a YDB status code
 *   - `transport_error` — gRPC client/transport failure (no server response)
 *   - error.name        — anything else (AbortError, TimeoutError, ...)
 *
 * `db.response.status_code` is set only in the first category.
 */
export function recordErrorAttributes(error: unknown): {
	[ATTR_DB_RESPONSE_STATUS_CODE]?: string
	[ATTR_ERROR_TYPE]: string
} {
	if (error instanceof YDBError) {
		return {
			[ATTR_DB_RESPONSE_STATUS_CODE]:
				YDBError.codes[error.code as StatusIds_StatusCode] ?? 'STATUS_CODE_UNSPECIFIED',
			[ATTR_ERROR_TYPE]: 'ydb_error',
		}
	}

	if (error instanceof ClientError) {
		return { [ATTR_ERROR_TYPE]: 'transport_error' }
	}

	if (error instanceof Error) {
		return { [ATTR_ERROR_TYPE]: error.name || 'Error' }
	}

	return { [ATTR_ERROR_TYPE]: 'unknown' }
}
