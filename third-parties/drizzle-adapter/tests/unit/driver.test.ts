import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Driver } from '@ydbjs/core'
import { YdbDriver } from '../../src/index.ts'
import { createMockQueryFunction } from '../helpers/mock-driver.ts'

test('borrowed driver', async () => {
	let readyCalls = 0
	let closeCalls = 0
	let signal = new AbortController().signal
	let borrowedDriver = Object.create(Driver.prototype) as Driver & {
		ready(signal?: AbortSignal): Promise<void>
		close(): void
	}

	borrowedDriver.ready = async (incomingSignal?: AbortSignal) => {
		readyCalls++
		assert.equal(incomingSignal, signal)
	}
	borrowedDriver.close = () => {
		closeCalls++
	}

	let driver = new YdbDriver(borrowedDriver)

	await driver.ready(signal)
	driver.close()

	assert.equal(driver.driver, borrowedDriver)
	assert.equal(readyCalls, 1)
	assert.equal(closeCalls, 0)
})

test('execute', async () => {
	let borrowedDriver = Object.create(Driver.prototype) as Driver
	let driver = new YdbDriver(borrowedDriver)
	let mockClient = createMockQueryFunction([{ pony: 'Twilight' }], [['Twilight', 7]])

	;(driver as any).client = mockClient.ql

	let executeResult = await driver.execute('select * from ponies', [1, 'Rainbow'], 'execute')
	let valuesResult = await driver.execute('select * from ponies', [2], 'all', {
		arrayMode: true,
		typings: ['none'],
	})

	assert.deepEqual(executeResult.rows, [{ pony: 'Twilight' }])
	assert.equal(executeResult.rowCount, 1)
	assert.equal(executeResult.command, 'execute')
	assert.deepEqual(executeResult.meta, {
		arrayMode: false,
		typings: undefined,
	})
	assert.deepEqual(valuesResult.rows, [['Twilight', 7]])
	assert.equal(valuesResult.rowCount, 1)
	assert.equal(valuesResult.command, 'all')
	assert.deepEqual(valuesResult.meta, {
		arrayMode: true,
		typings: ['none'],
	})
	assert.equal(mockClient.calls.length, 2)
	assert.equal(mockClient.calls[0]?.text, 'select * from ponies')
	assert.deepEqual(
		mockClient.calls[0]?.params.map(({ name }) => name),
		['p0', 'p1']
	)
	assert.deepEqual(
		mockClient.calls[1]?.params.map(({ name }) => name),
		['p0']
	)
})

test('transaction', async () => {
	let borrowedDriver = Object.create(Driver.prototype) as Driver
	let driver = new YdbDriver(borrowedDriver)
	let txQuery = createMockQueryFunction([{ ok: true }])
	let beginCalls: unknown[][] = []

	;(driver as any).client = {
		begin: async (...args: unknown[]) => {
			beginCalls.push(args)

			let callback = (typeof args[0] === 'function' ? args[0] : args[1]) as (
				tx: any
			) => Promise<unknown>
			return callback(txQuery.ql)
		},
	}

	let txResult = await driver.transaction(
		async (tx) => {
			let result = await tx.execute('select tx', [9], 'execute')

			return result.rows
		},
		{ accessMode: 'read only' }
	)

	assert.deepEqual(txResult, [{ ok: true }])
	assert.equal(beginCalls.length, 1)
	assert.deepEqual(beginCalls[0]?.[0], { isolation: 'snapshotReadOnly', idempotent: true })
	assert.equal(txQuery.calls.length, 1)

	await driver.transaction(async () => 'ok', {
		isolationLevel: 'serializableReadWrite',
		idempotent: false,
	})
	assert.deepEqual(beginCalls[1]?.[0], { isolation: 'serializableReadWrite', idempotent: false })

	await driver.transaction(async () => 'no-config')
	assert.equal(typeof beginCalls[2]?.[0], 'function')
})

test('fromCallback', async () => {
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
