import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { BulkUpsertResponseSchema, TableServiceDefinition } from '@ydbjs/api/table'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { createServer } from 'nice-grpc'
import { afterEach, expect, test } from 'vitest'

import { table } from './index.js'

/**
 * Minimal in-memory TableService mock that records every BulkUpsert call and
 * lets each test script the response. Only the BulkUpsert method is wired up.
 */
async function startTableServer() {
	let calls: { table: string; rowsItemsCount: number }[] = []
	let nextStatuses: StatusIds_StatusCode[] = []

	let server = createServer()
	let subset = {
		bulkUpsert: TableServiceDefinition.bulkUpsert,
	}
	server.add(subset, {
		async bulkUpsert(req) {
			calls.push({
				table: req.table,
				rowsItemsCount: req.rows?.value?.items.length ?? 0,
			})

			let status = nextStatuses.shift() ?? StatusIds_StatusCode.SUCCESS

			return create(BulkUpsertResponseSchema, {
				operation: {
					ready: true,
					status,
					issues: [],
				},
			})
		},
	})

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	return {
		driver,
		get calls() {
			return calls
		},
		pushStatus(status: StatusIds_StatusCode) {
			nextStatuses.push(status)
		},
		async close() {
			driver.close()
			await server.shutdown()
		},
	}
}

type Harness = Awaited<ReturnType<typeof startTableServer>>
let srv: Harness | undefined

afterEach(async () => {
	await srv?.close()
	srv = undefined
})

test('sends rows to the configured table path', async () => {
	srv = await startTableServer()
	let client = table(srv.driver)

	await client.bulkUpsert('/local/users', [
		{ id: 1n, name: 'Neo' },
		{ id: 2n, name: 'Trinity' },
	])

	expect(srv.calls).toHaveLength(1)
	expect(srv.calls[0]!.table).toBe('/local/users')
	expect(srv.calls[0]!.rowsItemsCount).toBe(2)
})

test('throws YDBError when the server returns a non-success status', async () => {
	srv = await startTableServer()
	srv.pushStatus(StatusIds_StatusCode.BAD_REQUEST)

	let client = table(srv.driver)
	await expect(
		client.bulkUpsert('/local/users', [{ id: 1n, name: 'Neo' }])
	).rejects.toBeInstanceOf(YDBError)
})

test('retries retryable errors and eventually succeeds', async () => {
	srv = await startTableServer()
	// First attempt: OVERLOADED (retryable). Second: success.
	srv.pushStatus(StatusIds_StatusCode.OVERLOADED)

	let client = table(srv.driver)
	await client.bulkUpsert('/local/users', [{ id: 1n, name: 'Neo' }])

	expect(srv.calls).toHaveLength(2)
})

test('does not retry non-retryable errors', async () => {
	srv = await startTableServer()
	srv.pushStatus(StatusIds_StatusCode.BAD_REQUEST)

	let client = table(srv.driver)
	await expect(
		client.bulkUpsert('/local/users', [{ id: 1n, name: 'Neo' }])
	).rejects.toBeInstanceOf(YDBError)

	expect(srv.calls).toHaveLength(1)
})

test('rejects when rows is not a List value', async () => {
	srv = await startTableServer()
	let client = table(srv.driver)

	await expect(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		client.bulkUpsert('/local/users', 'not a list' as any)
	).rejects.toBeInstanceOf(TypeError)

	expect(srv.calls).toHaveLength(0)
})

test('rejects empty table path', async () => {
	srv = await startTableServer()
	let client = table(srv.driver)

	await expect(client.bulkUpsert('', [{ id: 1n }])).rejects.toBeInstanceOf(TypeError)
})

test('aborts the request when the caller signal fires', async () => {
	srv = await startTableServer()
	let client = table(srv.driver)
	let controller = new AbortController()
	controller.abort(new Error('caller aborted'))

	await expect(
		client.bulkUpsert('/local/users', [{ id: 1n, name: 'Neo' }], {
			signal: controller.signal,
		})
	).rejects.toThrow(/abort/i)
})
