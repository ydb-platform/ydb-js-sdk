import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { BulkUpsertRequestSchema, TableServiceDefinition } from '@ydbjs/api/table'
import { TypedValueSchema } from '@ydbjs/api/value'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { type RetryConfig, defaultRetryConfig, isRetryableError, retry } from '@ydbjs/retry'
import { type JSValue, TypeKind, type Value, fromJs } from '@ydbjs/value'
import { List } from '@ydbjs/value/list'

let dbg = loggers.table.extend('bulk-upsert')

export interface BulkUpsertOptions {
	/**
	 * Abort signal to cancel the operation.
	 */
	signal?: AbortSignal
	/**
	 * Operation timeout in milliseconds. When elapsed, the RPC is aborted.
	 */
	timeout?: number
	/**
	 * Whether BulkUpsert retries should treat the operation as idempotent.
	 *
	 * BulkUpsert is an upsert, so repeating it with the same payload is safe.
	 * Defaults to `true`.
	 */
	idempotent?: boolean
}

/**
 * Normalize the `rows` argument to a `List<Struct>` `Value`.
 *
 * Accepts either a pre-built `Value` (when the caller wants precise type
 * control — typically a `List<Struct>`) or a plain array of objects, which is
 * converted through `fromJs`.
 */
function toListValue(rows: Value | readonly JSValue[]): Value {
	if (
		typeof rows === 'object' &&
		rows !== null &&
		'type' in rows &&
		'encode' in rows &&
		typeof (rows as Value).encode === 'function'
	) {
		if ((rows as Value).type.kind !== TypeKind.LIST) {
			throw new TypeError('BulkUpsert rows must be a List value (typically List<Struct>).')
		}
		return rows as Value
	}

	if (!Array.isArray(rows)) {
		throw new TypeError(
			'BulkUpsert rows must be an array of objects or a @ydbjs/value List value.'
		)
	}

	if (rows.length === 0) {
		// Empty list — let caller express an explicit typed List themselves if
		// they need this. Sending an empty List with NullType does not carry
		// enough schema info for the server to accept.
		return new List()
	}

	return fromJs(rows as JSValue[])
}

/**
 * Execute a BulkUpsert against the given table path.
 *
 * See {@link TableClient.bulkUpsert}.
 */
export async function bulkUpsert(
	driver: Driver,
	tablePath: string,
	rows: Value | readonly JSValue[],
	options: BulkUpsertOptions = {}
): Promise<void> {
	if (typeof tablePath !== 'string' || tablePath.length === 0) {
		throw new TypeError('BulkUpsert tablePath must be a non-empty string.')
	}

	let rowsValue = toListValue(rows)

	dbg.log('preparing bulk upsert to %s', tablePath)

	let typedRows = create(TypedValueSchema, {
		type: rowsValue.type.encode(),
		value: rowsValue.encode(),
	})

	let signals: AbortSignal[] = []
	if (options.signal) signals.push(options.signal)
	if (options.timeout && options.timeout > 0) {
		signals.push(AbortSignal.timeout(options.timeout))
	}
	let signal = signals.length > 0 ? AbortSignal.any(signals) : undefined

	let idempotent = options.idempotent ?? true

	let retryConfig: RetryConfig = {
		...defaultRetryConfig,
		...(signal ? { signal } : {}),
		idempotent,
		retry: (error, idempotentFlag) => isRetryableError(error, idempotentFlag),
		onRetry: (ctx) => {
			dbg.log(
				'retrying bulk upsert to %s, attempt %d, error: %O',
				tablePath,
				ctx.attempt,
				ctx.error
			)
		},
	}

	await driver.ready(signal)

	await retry(retryConfig, async (retrySignal) => {
		let client = driver.createClient(TableServiceDefinition)

		let request = create(BulkUpsertRequestSchema, {
			table: tablePath,
			rows: typedRows,
		})

		let response = await client.bulkUpsert(request, { signal: retrySignal })

		// YDB returns the operation synchronously for BulkUpsert. Missing
		// operation is treated as a protocol error.
		if (!response.operation) {
			throw new Error('BulkUpsert response missing operation.')
		}

		if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
			dbg.log('bulk upsert to %s failed, status: %d', tablePath, response.operation.status)
			throw new YDBError(response.operation.status, response.operation.issues)
		}

		dbg.log('bulk upsert to %s succeeded', tablePath)
	})
}
