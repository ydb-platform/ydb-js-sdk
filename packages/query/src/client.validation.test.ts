import { expect, test } from 'vitest'
import { Int32, Int32Type } from '@ydbjs/value/primitive'

import { QueryClient } from './client.ts'
import { startClientServer } from './client.fixtures.ts'
import { query } from './index.ts'

test('tagged queries can be cancelled or disposed before execution without starting work', async () => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let sql = query(client)
	let cancelled = sql`SELECT 1`
	cancelled.cancel()
	expect(cancelled.cancelled).toBe(true)
	await expect(Promise.resolve(cancelled)).rejects.toBe('Query cancelled by user.')
	let disposed = sql`SELECT 2`
	disposed.destroy()
	await expect(Promise.resolve(disposed)).rejects.toThrow('Query has been disposed.')
	expect(server.executions).toHaveLength(0)
})

test('misplaced callback options are rejected before any transaction starts', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let sql = query(client)
	let calls = 0
	let callback = async () => {
		calls++
	}
	// @ts-expect-error Exercise the incorrect JavaScript argument order.
	await expect(client.retrySession(callback, { signal: tc.signal })).rejects.toThrow(
		'retrySession(options, callback)'
	)
	// @ts-expect-error Exercise the incorrect JavaScript argument order.
	await expect(client.retryTransaction(callback, { signal: tc.signal })).rejects.toThrow(
		'retryTransaction(options, callback)'
	)
	// @ts-expect-error The tagged facade keeps its options-first argument order.
	await expect(sql.do(callback, { signal: tc.signal })).rejects.toThrow('do(options, callback)')
	// @ts-expect-error The tagged facade keeps its options-first argument order.
	await expect(sql.begin(callback, { signal: tc.signal })).rejects.toThrow(
		'transaction(options, callback)'
	)
	expect(calls).toBe(0)
	expect(server.executions).toHaveLength(0)
	expect(server.begins).toHaveLength(0)
})

test.for(['beforeCommit', 'onRollback', 'onClose'] as const)(
	'invalid %s hooks fail before commit',
	async (hook, tc) => {
		using server = await startClientServer()
		await using client = new QueryClient(server.driver)
		await expect(
			client.retryTransaction({ signal: tc.signal }, async (transaction) => {
				// @ts-expect-error Runtime callers must not defer this error until after commit.
				transaction[hook](42)
				await transaction.execute('UPDATE data')
			})
		).rejects.toThrow('requires a callback')
		expect(server.executions).toHaveLength(0)
		expect(server.commits).toHaveLength(0)
		expect(server.rollbacks).toHaveLength(1)
	}
)

test('invalid retry configuration cannot silently enable default retries', async () => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	await expect(
		// @ts-expect-error A boolean must not be interpreted as an empty retry object.
		client.retrySession({ retry: false }, (session) => session.execute('UPDATE data'))
	).rejects.toThrow('retry must be an object')
	await expect(
		// @ts-expect-error Invalid callbacks are rejected before the first request.
		client.retrySession({ onRetry: 'callback' }, (session) => session.execute('UPDATE data'))
	).rejects.toThrow('onRetry must be a callback')
	// @ts-expect-error A transaction isolation string is not an options object.
	await expect(client.retryTransaction('snapshotReadOnly', async () => {})).rejects.toThrow(
		'options must be an object'
	)
	expect(server.executions).toHaveLength(0)
	expect(server.begins).toHaveLength(0)
})

test('cancelled or closed clients do not encode parameters', async () => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let encoded = 0
	let value = {
		type: new Int32Type(),
		encode() {
			encoded++
			return new Int32(1).encode()
		},
	}
	let reason = new Error('already cancelled')
	await expect(
		client.retrySession(
			{
				signal: AbortSignal.abort(reason),
			},
			(session) => session.execute('SELECT $id', { id: value })
		)
	).rejects.toBe(reason)
	await client.close()
	await expect(
		client.retrySession((session) => session.execute('SELECT $id', { id: value }))
	).rejects.toThrow('session pool is closed')
	expect(encoded).toBe(0)
	expect(server.executions).toHaveLength(0)
})
