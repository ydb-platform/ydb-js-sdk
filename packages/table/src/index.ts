import type { Driver } from '@ydbjs/core'
import type { JSValue, Value } from '@ydbjs/value'

import { type BulkUpsertOptions, bulkUpsert } from './bulk-upsert.js'

export { type BulkUpsertOptions } from './bulk-upsert.js'

/**
 * High-level client for the YDB Table service.
 *
 * Currently exposes `bulkUpsert` for high-throughput, non-transactional batch
 * ingestion. Additional Table service methods may be added later.
 */
export interface TableClient {
	/**
	 * Upsert a batch of rows into `tablePath` non-transactionally.
	 *
	 * The server splits the request into independent transactions per
	 * partition and runs them in parallel. The whole call either succeeds —
	 * in which case every row was applied — or fails; atomicity across
	 * partitions is not guaranteed on failure.
	 *
	 * `rows` accepts either:
	 *  - a plain array of objects, which is converted through
	 *    {@link @ydbjs/value#fromJs} (convenient, infers types from JS values); or
	 *  - a pre-built `Value` (typically a `List<Struct>`), for precise
	 *    control over column types.
	 *
	 * Every row must include all primary key columns. Non-key columns are
	 * updated when present, like a regular `UPSERT`.
	 *
	 * Retryable errors are retried automatically. Because BulkUpsert is
	 * idempotent, retries are on by default; set `idempotent: false` to
	 * opt out.
	 *
	 * @param tablePath Absolute table path (without the database prefix).
	 * @param rows      Rows to upsert.
	 * @param options   Abort signal, operation timeout, retry control.
	 *
	 * @example
	 * ```ts
	 * let client = table(driver)
	 * await client.bulkUpsert('/local/my_table', [
	 *   { id: 1n, name: 'foo' },
	 *   { id: 2n, name: 'bar' },
	 * ])
	 * ```
	 */
	bulkUpsert(
		tablePath: string,
		rows: Value | readonly JSValue[],
		options?: BulkUpsertOptions
	): Promise<void>
}

/**
 * Create a {@link TableClient} bound to the given driver.
 *
 * @example
 * ```ts
 * import { Driver } from '@ydbjs/core'
 * import { table } from '@ydbjs/table'
 *
 * let driver = new Driver(connectionString)
 * await driver.ready()
 *
 * let client = table(driver)
 * await client.bulkUpsert('/local/users', [{ id: 1n, name: 'Neo' }])
 * ```
 */
export function table(driver: Driver): TableClient {
	return {
		bulkUpsert(tablePath, rows, options) {
			return bulkUpsert(driver, tablePath, rows, options)
		},
	}
}
