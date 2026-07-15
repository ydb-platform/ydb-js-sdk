import type { Attributes } from '@opentelemetry/api'
import {
	ATTR_DB_NAMESPACE,
	ATTR_DB_RESPONSE_STATUS_CODE,
	ATTR_DB_SYSTEM_NAME,
	ATTR_ERROR_TYPE,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
} from '@opentelemetry/semantic-conventions'

import type { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { DriverIdentity } from '@ydbjs/core'
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
// Bridge (2DC) pile the node belongs to; '' / absent on a non-bridge cluster.
export let ATTR_YDB_NODE_PILE = 'ydb.node.pile'

/**
 * Per-driver identity attributes (`db.namespace`, `server.address`,
 * `server.port`). Returns an empty object when no identity is present so
 * callers can spread the result unconditionally. Used by both the traces
 * and the metrics pipeline.
 */
export function identityAttrs(driver: DriverIdentity | undefined): Attributes {
	if (!driver) return {}
	let attrs: Attributes = {
		[ATTR_DB_NAMESPACE]: driver.database,
		[ATTR_SERVER_ADDRESS]: driver.address,
	}
	if (driver.port !== undefined) attrs[ATTR_SERVER_PORT] = driver.port
	return attrs
}

/**
 * Coerce an arbitrary thrown value into an `Error` suitable for
 * `span.recordException`. We do NOT stringify the value via its own
 * `toString` because a custom implementation could leak secrets (tokens,
 * credentials) into the recorded exception.
 */
export function coerceError(value: unknown): Error {
	if (value instanceof Error) return value
	if (typeof value === 'string') return new Error(value)
	return new Error('non-Error throw')
}

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
