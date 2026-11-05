import { expect, test, vi } from 'vitest'
import * as assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { Type_PrimitiveTypeId as TypeId } from '@ydbjs/api/value'
import { kRegisterLibrary } from '@ydbjs/core'
import { QueryClient } from '@ydbjs/query'
import { Uint16 } from '@ydbjs/value/primitive'
import { YdbDriver, YdbRetryableQueryError, drizzle } from '../index.ts'
import {
	resultPart,
	startClientServer,
	statusPart,
} from '../../../../packages/query/src/client.fixtures.ts'
import pkg from '../../package.json' with { type: 'json' }

test('closes the owned pool and registers borrowed drivers and clients', async (tc) => {
	using server = await startClientServer()
	let ready = vi.spyOn(server.driver, 'ready')
	let register = vi.spyOn(server.driver, kRegisterLibrary)
	let adapter = new YdbDriver(server.driver)

	await adapter.ready(tc.signal)
	adapter.close()

	expect(ready).toHaveBeenCalledWith(tc.signal)
	expect(adapter.client.closed).toBe(true)

	await using client = new QueryClient(server.driver)
	let db = drizzle({ client })

	await db.$client.close?.()
	let result = await client.retrySession({ signal: tc.signal }, (session) => {
		return session.execute('SELECT 1')
	})

	expect(result.resultSets[0]?.rows).toEqual([{ id: 1 }])
	expect(register.mock.calls).toEqual([
		['@ydbjs/drizzle-adapter', pkg.version],
		['@ydbjs/drizzle-adapter', pkg.version],
	])
})

test('replays a standalone statement with its original parameters and preserves row modes and metadata', async () => {
	let bytes = Buffer.from([1, 2])
	let id = new Uint16(12)
	let params = [bytes, id, 'Rainbow']
	let attempts = 0
	using server = await startClientServer({
		async *executeQuery() {
			if (++attempts === 1) {
				bytes.fill(0)
				id.type.encode().type = { case: 'typeId', value: TypeId.INT32 }
				id.encode().value = { case: 'int32Value', value: 99 }
				params[2] = 'Rose'
				yield statusPart(Status.ABORTED)
			} else {
				yield resultPart([7])
			}
		},
	})
	await using client = new QueryClient(server.driver)
	let driver = new YdbDriver(client)
	let text = 'SELECT $p0, $p1, $p2'

	let result = await driver.execute(text, params, 'execute')
	let values = await driver.execute('SELECT 7', [], 'all', { arrayMode: true, typings: ['none'] })

	expect(driver.client).toBe(client)
	expect(server.executions).toHaveLength(3)

	for (let request of server.executions.slice(0, 2)) {
		expect(request.query).toMatchObject({ case: 'queryContent', value: { text } })
		expect(Object.keys(request.parameters)).toEqual(['$p0', '$p1', '$p2'])
		expect(request.parameters.$p0?.type?.type).toEqual({ case: 'typeId', value: TypeId.STRING })
		let received = request.parameters.$p0?.value?.value
		expect(received?.case === 'bytesValue' ? [...received.value] : undefined).toEqual([1, 2])
		expect(request.parameters.$p1).toMatchObject({
			type: { type: { case: 'typeId', value: TypeId.UINT16 } },
			value: { value: { case: 'uint32Value', value: 12 } },
		})
		expect(request.parameters.$p2).toMatchObject({
			type: { type: { case: 'typeId', value: TypeId.UTF8 } },
			value: { value: { case: 'textValue', value: 'Rainbow' } },
		})
	}

	expect(Object.getPrototypeOf(result.rows[0])).toBe(null)
	expect(result).toEqual({
		rows: [{ id: 7 }],
		rowCount: 1,
		command: 'execute',
		meta: { arrayMode: false, typings: undefined },
	})
	expect(values).toEqual({
		rows: [[7]],
		rowCount: 1,
		command: 'all',
		meta: { arrayMode: true, typings: ['none'] },
	})
})

test('replays the whole transaction when a root statement aborts', async () => {
	let statements = 0
	using server = await startClientServer({
		async *executeQuery() {
			yield ++statements === 2 ? statusPart(Status.ABORTED) : resultPart([1])
		},
	})
	await using client = new QueryClient(server.driver, {
		poolOptions: { maxSize: 1, waitQueueFactor: 0 },
	})
	let db = drizzle(client)
	let callbacks = 0

	await db.transaction(async (tx) => {
		callbacks++
		await tx.execute(sql`SELECT 1`)
		await db.execute(sql`SELECT 2`)
	})

	expect(callbacks).toBe(2)
	expect(server.begins).toHaveLength(2)
	expect(server.rollbacks).toHaveLength(1)
	expect(server.commits).toHaveLength(1)

	let rolledBack = server.rollbacks[0]!.txId
	let committed = server.commits[0]!.txId
	expect(rolledBack).not.toBe(committed)
	expect(
		server.executions.map((request) => {
			return request.txControl?.txSelector
		})
	).toEqual(
		[rolledBack, rolledBack, committed, committed].map((value) => {
			return { case: 'txId', value }
		})
	)
})

test.for([undefined, false])(
	'read-only transactions with idempotent=%s preserve an uncertain outcome',
	async (idempotent) => {
		let statements = 0
		using server = await startClientServer({
			async *executeQuery() {
				yield ++statements === 1 ? statusPart(Status.UNDETERMINED) : resultPart([1])
			},
		})
		await using client = new QueryClient(server.driver)
		let db = drizzle(client)

		let transaction = db.transaction(
			(tx) => {
				return tx.execute(sql`SELECT 1`)
			},
			{
				accessMode: 'read only',
				...(idempotent === undefined ? {} : { idempotent }),
			}
		)

		await expect(transaction).rejects.toBeInstanceOf(YdbRetryableQueryError)
		expect(
			server.begins.map((request) => {
				return request.txSettings?.txMode.case
			})
		).toEqual(['snapshotReadOnly'])
		expect(server.commits).toHaveLength(0)
	}
)

test('rejects with the original Drizzle error after the callback catches a failed statement', async () => {
	using server = await startClientServer({
		async *executeQuery() {
			yield statusPart(Status.BAD_REQUEST)
		},
	})
	await using client = new QueryClient(server.driver)
	let db = drizzle(client)
	let statementError: unknown

	let operation = db.transaction(async (tx) => {
		try {
			await tx.execute(sql`SELECT ${42}`)
		} catch (error) {
			statementError = error
		}
	})

	let terminalError = await operation.catch((error: unknown) => {
		return error
	})

	expect(statementError).toBeInstanceOf(DrizzleQueryError)
	expect(terminalError).toBe(statementError)
	expect(terminalError).toMatchObject({
		query: 'SELECT $p0',
		params: [42],
		cause: { code: Status.BAD_REQUEST },
	})
	expect(server.rollbacks).toHaveLength(1)
	expect(server.commits).toHaveLength(0)
})

test('a one-attempt transaction returns the aborted statement to the caller', async (tc) => {
	using server = await startClientServer({
		async *executeQuery() {
			yield statusPart(Status.ABORTED)
		},
	})
	await using client = new QueryClient(server.driver)
	let db = drizzle(client)

	let operation = db.transaction(
		(tx) => {
			return tx.execute(sql`SELECT 1`)
		},
		{
			signal: tc.signal,
			retry: { budget: 1 },
		}
	)

	await expect(operation).rejects.toBeInstanceOf(YdbRetryableQueryError)
	expect(server.begins).toHaveLength(1)
	expect(server.rollbacks).toHaveLength(1)
})

test('preserves application errors wrapping a failed statement', async () => {
	let statements = 0
	using server = await startClientServer({
		async *executeQuery() {
			yield ++statements === 1 ? statusPart(Status.ABORTED) : resultPart([1])
		},
	})
	await using client = new QueryClient(server.driver)
	let db = drizzle(client)
	let statementError: unknown
	let applicationError: DrizzleQueryError | undefined

	let operation = db.transaction(async (tx) => {
		try {
			await tx.execute(sql`SELECT 1`)
		} catch (error) {
			statementError = error
			applicationError = new DrizzleQueryError(
				'application query',
				[],
				(error as DrizzleQueryError).cause
			)
			throw applicationError
		}
	})

	let caught = await operation.catch((error: unknown) => {
		return error
	})

	expect(statementError).toBeInstanceOf(YdbRetryableQueryError)
	expect(applicationError).toBeInstanceOf(DrizzleQueryError)
	expect(caught).toBe(applicationError)
	expect(server.begins).toHaveLength(1)
})

test('rejects multi-result-set responses', async () => {
	using server = await startClientServer({
		async *executeQuery() {
			yield resultPart([1], 0)
			yield resultPart([2], 1)
		},
	})
	await using client = new QueryClient(server.driver)
	let driver = new YdbDriver(client)

	await assert.rejects(driver.execute('select 1; select 2', [], 'execute'), /2 result sets/)
})

test('creates an executor from a remote callback', async () => {
	let calls: Array<{ sql: string; params: unknown[]; method: string; options: unknown }> = []
	let executor = YdbDriver.fromCallback(async (query, params, method, options) => {
		calls.push({ sql: query, params, method, options })

		return { rows: [{ ok: true }] }
	})

	let result = await executor.execute('select 1', [1], 'execute', { arrayMode: true })

	assert.deepEqual(result.rows, [{ ok: true }])
	assert.deepEqual(calls, [
		{
			sql: 'select 1',
			params: [1],
			method: 'execute',
			options: { arrayMode: true },
		},
	])
})
