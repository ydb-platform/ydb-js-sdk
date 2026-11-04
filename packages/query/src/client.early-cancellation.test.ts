import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import { QueryClient, type QueryExecutor } from './client.js'
import { startClientServer } from './client.fixtures.js'
import { type SQLClient, query } from './index.js'

type CancellationContext = {
	client: QueryClient
	session: QueryExecutor
	sql: SQLClient
	reason: YDBError
	cancelled: AbortSignal
	innerCallback: () => Promise<void>
}

type CancellationCase = {
	name: string
	action: (context: CancellationContext) => PromiseLike<unknown>
	expectedExecutions: number
}

let scenarios: CancellationCase[] = [
	{
		name: 'nested session',
		action: ({ client, cancelled, innerCallback }) =>
			client.retrySession({ signal: cancelled }, innerCallback),
		expectedExecutions: 0,
	},
	{
		name: 'nested transaction',
		action: ({ client, cancelled, innerCallback }) =>
			client.retryTransaction({ signal: cancelled }, innerCallback),
		expectedExecutions: 0,
	},
	{
		name: 'execute',
		action: ({ session, cancelled }) => session.execute('SELECT 1', {}, { signal: cancelled }),
		expectedExecutions: 0,
	},
	{
		name: 'stream',
		action: ({ session, cancelled }) =>
			session.stream('SELECT 1', {}, { signal: cancelled }).next(),
		expectedExecutions: 0,
	},
	{
		name: 'deferred stream',
		action: ({ session, reason }) => {
			let controller = new AbortController()
			let stream = session.stream('SELECT 1', {}, { signal: controller.signal })

			controller.abort(reason)
			return stream.next()
		},
		expectedExecutions: 0,
	},
	{
		name: 'cancelled stream',
		action: ({ session, reason }) => {
			let stream = session.stream('SELECT 1')

			stream.cancel(reason)
			return stream.next()
		},
		expectedExecutions: 0,
	},
	{
		name: 'thrown stream',
		action: ({ session, reason }) => session.stream('SELECT 1').throw(reason),
		expectedExecutions: 0,
	},
	{
		name: 'cancel then throw',
		action({ session, reason }) {
			let stream = session.stream('SELECT 1')

			stream.cancel(reason)
			throw reason
		},
		expectedExecutions: 0,
	},
	{
		name: 'paused cancel then throw',
		async action({ session, reason }) {
			let stream = session.stream('SELECT 1')
			await stream.next()

			stream.cancel(reason)
			throw reason
		},
		expectedExecutions: 1,
	},
	{
		name: 'tagged query',
		action: ({ sql, cancelled }) => sql`SELECT 1`.signal(cancelled),
		expectedExecutions: 0,
	},
	{
		name: 'tagged completion',
		action: ({ sql, reason }) => {
			let controller = new AbortController()
			let statement = sql`SELECT 1`.signal(controller.signal)

			statement.on('done', () => controller.abort(reason))
			return statement
		},
		expectedExecutions: 1,
	},
]

for (let outer of ['session', 'transaction'] as const) {
	for (let scenario of scenarios) {
		test(`${outer} does not retry after cancellation in ${scenario.name}`, async (tc) => {
			using server = await startClientServer()
			await using client = new QueryClient(server.driver)
			let sql = query(client)
			let reason = new YDBError(Status.ABORTED, [])
			let cancelled = AbortSignal.abort(reason)
			let callbacks = 0
			let innerCallbacks = 0
			let options = {
				signal: tc.signal,
				idempotent: false,
				retry: { budget: 3, strategy: 0 },
			}
			let callback = async (session: QueryExecutor) => {
				callbacks++
				return scenario.action({
					client,
					session,
					sql,
					reason,
					cancelled,
					async innerCallback() {
						innerCallbacks++
					},
				})
			}

			let operation =
				outer === 'session'
					? client.retrySession(options, callback)
					: client.retryTransaction(options, callback)

			await expect(operation).rejects.toMatchObject({ cause: reason })
			expect(callbacks).toBe(1)
			expect(innerCallbacks).toBe(0)
			expect(server.executions).toHaveLength(scenario.expectedExecutions)
			expect(server.commits).toHaveLength(0)
			expect(server.rollbacks).toHaveLength(outer === 'transaction' ? 1 : 0)
		})
	}
}
