import { AsyncLocalStorage } from 'node:async_hooks'
import { tracingChannel } from 'node:diagnostics_channel'

import { QueryClient, query } from '@ydbjs/query'
import { expect, test } from 'vitest'

import { startClientServer } from './client.fixtures.ts'

test('ExecuteQuery RPCs inherit the query trace context without changing consumer context', async (tc) => {
	let storage = new AsyncLocalStorage<string>()
	let trace = tracingChannel('tracing:ydb:query.execute')
	let starts: Array<string | undefined> = []
	let completions: Array<string | undefined> = []
	let policies: boolean[] = []
	let subscriber = (context: unknown) => {
		policies.push((context as { idempotent: boolean }).idempotent)
	}
	trace.start.bindStore(storage, () => 'query')
	trace.start.subscribe(subscriber)
	tc.onTestFinished(() => {
		trace.start.unbindStore(storage)
		trace.start.unsubscribe(subscriber)
		storage.disable()
	})
	using server = await startClientServer(
		{},
		{
			hooks: {
				onCall(event) {
					if (!event.method.endsWith('/ExecuteQuery')) return
					starts.push(storage.getStore())
					return () => {
						completions.push(storage.getStore())
					}
				},
			},
		}
	)
	await using client = new QueryClient(server.driver)
	await storage.run('caller', async () => {
		await client.retrySession({ signal: tc.signal, idempotent: true }, (session) =>
			session.execute('SELECT 1')
		)
		expect(storage.getStore()).toBe('caller')
		await client.retrySession({ signal: tc.signal }, async (scope) => {
			for await (let part of scope.stream('SELECT 1')) {
				expect(part.rows).toEqual([{ id: 1 }])
				expect(storage.getStore()).toBe('caller')
			}
		})
		await query(client)`SELECT 1`.idempotent().signal(tc.signal)
	})
	expect(starts).toEqual(['query', 'query', 'query'])
	expect(completions).toEqual(['query', 'query', 'query'])
	expect(policies).toEqual([true, false, true])
})
