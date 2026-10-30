import { expect, test } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import { BeginTransactionResponseSchema, CommitTransactionResponseSchema } from '@ydbjs/api/query'
import { YDBError } from '@ydbjs/error'

import { QueryClient, type QueryExecutor, type QueryStream, type Transaction } from './client.ts'
import { onAbort, resultPart, startClientServer, statusPart } from './client.fixtures.ts'
import { SessionAbortedError } from './session.ts'

test('retrySession retries the whole streaming callback with fresh per-attempt state', async (tc) => {
	let executions = 0
	using server = await startClientServer({
		async *executeQuery() {
			if (++executions === 1) {
				yield resultPart([100])
				yield statusPart(Status.OVERLOADED)
				return
			}
			yield resultPart([1, 2])
		},
	})
	await using client = new QueryClient(server.driver)
	let attempts: number[][] = []
	let total = await client.retrySession(
		{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
		async (executor) => {
			let rows: number[] = []
			attempts.push(rows)
			for await (let part of executor.stream<{ id: number }>('SELECT id')) {
				for (let row of part.rows) rows.push(row.id)
			}
			return rows.reduce((sum, value) => sum + value, 0)
		}
	)
	expect(total).toBe(3)
	expect(attempts).toEqual([[100], [1, 2]])
	expect(executions).toBe(2)
})

test('a scoped stream leaves retry ownership with its callback', async (tc) => {
	using server = await startClientServer({
		async *executeQuery() {
			yield resultPart([100])
			yield statusPart(Status.OVERLOADED)
		},
	})
	await using client = new QueryClient(server.driver)
	let stream: QueryStream<{ id: number }> | undefined
	let rows: number[] = []
	let operation = client.retrySession(
		{ signal: tc.signal, retry: { budget: 1 } },
		async (session) => {
			stream = session.stream<{ id: number }>('SELECT id')
			for await (let part of stream) for (let row of part.rows) rows.push(row.id)
		}
	)
	await expect(operation).rejects.toMatchObject({ code: Status.OVERLOADED })
	expect(rows).toEqual([100])
	expect(stream?.summary).toBeUndefined()
	expect(server.executions).toHaveLength(1)
})

test('the root client exposes only callback scopes for query execution', async () => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	expect(typeof client.retrySession).toBe('function')
	expect(typeof client.retryTransaction).toBe('function')
	for (let method of ['execute', 'do', 'transaction', 'stream']) {
		expect(method in client).toBe(false)
	}
	expect(server.executions).toHaveLength(0)
})

test('abandoning a scoped stream does not become a retryable session failure', async (tc) => {
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			yield resultPart([1])
			await onAbort(context.signal)
		},
	})
	await using client = new QueryClient(server.driver)
	let attempts = 0
	await expect(
		client.retrySession(
			{ signal: tc.signal, idempotent: true, retry: { budget: 3, strategy: 0 } },
			async (session) => {
				attempts++
				for await (let part of session.stream('SELECT id')) {
					expect(part.rows).toEqual([{ id: 1 }])
					break
				}
				session.signal.throwIfAborted()
			}
		)
	).rejects.toThrow('closed before completion')
	expect(attempts).toBe(1)
	expect(server.executions).toHaveLength(1)
})

test('a local stream cancellation reason cannot request a callback retry', async (tc) => {
	let entered = Promise.withResolvers<void>()
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			entered.resolve()
			await onAbort(context.signal)
			yield* []
		},
	})
	await using client = new QueryClient(server.driver)
	let reason = new YDBError(Status.ABORTED, [])
	let attempts = 0
	await expect(
		client.retrySession(
			{ signal: tc.signal, idempotent: true, retry: { budget: 3, strategy: 0 } },
			async (session) => {
				attempts++
				let stream = session.stream('SELECT id')
				let pending = stream.next().catch((error: unknown) => error)
				await abortable(tc.signal, entered.promise)
				stream.cancel(reason)
				expect(await pending).toBe(reason)
			}
		)
	).rejects.toThrow('closed before completion')
	expect(attempts).toBe(1)
	expect(server.executions).toHaveLength(1)
})

test('retrySession rejects invalid options through its returned promise', async () => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let operation: Promise<unknown> | undefined
	expect(() => {
		operation = client.retrySession(
			{
				idempotent: 'false' as unknown as boolean,
			},
			(session) => session.execute('SELECT 1')
		)
	}).not.toThrow()
	await expect(operation).rejects.toThrow('idempotent must be a boolean')
	expect(server.executions).toHaveLength(0)
})

test('execute discards partial output before retrying a failed attempt', async (tc) => {
	let executions = 0
	using server = await startClientServer({
		async *executeQuery() {
			if (++executions === 1) {
				yield resultPart([100])
				yield statusPart(Status.OVERLOADED)
				return
			}
			yield resultPart([1])
			yield resultPart([2])
			yield resultPart([3], 1)
		},
	})
	await using client = new QueryClient(server.driver)
	let result = await client.retrySession(
		{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
		(session) => session.execute<{ id: number }>('SELECT id; SELECT other')
	)
	expect(result.resultSets.map((set) => set.rows)).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]])
	expect(server.executions).toHaveLength(2)
})

test('a callback executor leaves retry ownership with the enclosing operation', async (tc) => {
	using server = await startClientServer({
		async *executeQuery() {
			yield statusPart(Status.OVERLOADED)
		},
	})
	await using client = new QueryClient(server.driver)
	await expect(
		client.retrySession(
			{ signal: tc.signal, retry: { budget: 1, strategy: 0 } },
			async (executor) => {
				await executor.execute('SELECT 1')
			}
		)
	).rejects.toMatchObject({ code: Status.OVERLOADED })
	expect(server.executions).toHaveLength(1)
})

test('a statement rejects its own retry policy inside a callback before execution', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	await expect(
		client.retrySession({ signal: tc.signal }, async (executor) => {
			// @ts-expect-error Retry ownership belongs to the callback, including for JavaScript callers.
			await executor.execute('SELECT 1', {}, { retry: { budget: 3 } })
		})
	).rejects.toThrow('retry belongs to retrySession')
	expect(server.executions).toHaveLength(0)
})

test('a statement cancellation signal can narrow its scope before execution', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let reason = new Error('statement cancelled')
	await client.retrySession({ signal: tc.signal }, async (session) => {
		await expect(
			session.execute('SELECT cancelled', {}, { signal: AbortSignal.abort(reason) })
		).rejects.toBe(reason)
		expect(session.signal.aborted).toBe(false)
		await session.execute('SELECT current')
	})
	expect(server.executions).toHaveLength(1)
})

test('a callback executor cannot start work after its attempt finishes', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let executor = await client.retrySession({ signal: tc.signal }, async (attempt) => attempt)
	await expect(async () => executor.execute('SELECT 1')).rejects.toThrow('attempt has ended')
	expect(() => executor.stream('SELECT 1')).toThrow('attempt has ended')
	expect(server.executions).toHaveLength(0)
})

test('returning an unconsumed stream rejects the callback instead of leaking its lease', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let escaped: QueryStream | undefined
	await expect(
		client.retrySession({ signal: tc.signal }, async (executor) => {
			escaped = executor.stream('SELECT 1')
			return escaped
		})
	).rejects.toThrow('Consume query streams inside the callback')
	await expect(escaped!.next()).rejects.toBeInstanceOf(Error)
	let result = await client.retrySession(
		{
			signal: tc.signal,
		},
		(session) => session.execute('SELECT 2')
	)
	expect(result.resultSets[0]!.rows).toEqual([{ id: 1 }])
	expect(server.executions).toHaveLength(1)
})

test('an executor from a failed attempt cannot join its retry', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let stale: QueryExecutor | undefined
	let attempts = 0
	await client.retrySession(
		{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
		async (executor) => {
			if (++attempts === 1) {
				stale = executor
				throw new YDBError(Status.OVERLOADED, [])
			}
			expect(executor).not.toBe(stale)
			await expect(async () => stale!.execute('SELECT stale')).rejects.toThrow(
				'attempt has ended'
			)
			await executor.execute('SELECT current')
		}
	)
	expect(server.executions).toHaveLength(1)
})

test('a partially consumed callback stream is cancelled before its session can be reused', async (tc) => {
	let stopped = Promise.withResolvers<void>()
	let executions = 0
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			yield resultPart([1])
			if (++executions === 1) {
				await onAbort(context.signal)
				stopped.resolve()
			}
		},
	})
	await using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	await expect(
		client.retrySession({ signal: tc.signal }, async (executor) => {
			let stream = executor.stream('SELECT first')
			await stream.next()
		})
	).rejects.toThrow('Consume query streams inside the callback')
	await abortable(tc.signal, stopped.promise)
	await client.retrySession({ signal: tc.signal }, (session) => session.execute('SELECT next'))
	expect(server.executions).toHaveLength(2)
	expect(server.executions[1]!.sessionId).not.toBe(server.executions[0]!.sessionId)
})

test('concurrent transactions keep distinct identities and lifecycle hooks', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver, { poolOptions: { maxSize: 2 } })
	let entered = Promise.withResolvers<void>()
	let release = Promise.withResolvers<void>()
	let transactions: Transaction[] = []
	let events: string[] = []
	let run = (name: string) =>
		client.retryTransaction({ signal: tc.signal }, async (tx) => {
			transactions.push(tx)
			tx.onCommit(() => {
				events.push(`${name}:precommit:${tx.transactionId}`)
			})
			tx.onClose((committed) => {
				events.push(`${name}:close:${committed}:${tx.transactionId}`)
			})
			if (transactions.length === 2) entered.resolve()
			await abortable(tc.signal, release.promise)
			await tx.execute(`SELECT ${name}`)
			return tx.transactionId
		})
	let first = run('first')
	let second = run('second')
	await abortable(tc.signal, entered.promise)
	expect(transactions[0]).not.toBe(transactions[1])
	expect(transactions[0]!.sessionId).not.toBe(transactions[1]!.sessionId)
	expect(transactions[0]!.transactionId).not.toBe(transactions[1]!.transactionId)
	release.resolve()
	let [firstId, secondId] = await Promise.all([first, second])
	expect(events).toEqual(
		expect.arrayContaining([
			`first:precommit:${firstId}`,
			`first:close:true:${firstId}`,
			`second:precommit:${secondId}`,
			`second:close:true:${secondId}`,
		])
	)
	expect(events).toHaveLength(4)
	expect(server.commits.map((request) => request.txId).sort()).toEqual([firstId, secondId].sort())
	expect(server.rollbacks).toHaveLength(0)
	for (let request of server.executions) {
		let tx = transactions.find((candidate) => candidate.sessionId === request.sessionId)!
		expect(request.txControl?.txSelector).toEqual({ case: 'txId', value: tx.transactionId })
	}
})

test('a retryable close-hook error after successful commit does not repeat the transaction', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let calls = 0
	let failure = new YDBError(Status.OVERLOADED, [])
	await expect(
		client.retryTransaction(
			{ signal: tc.signal, idempotent: true, retry: { budget: 2, strategy: 0 } },
			async (tx) => {
				calls++
				tx.onClose((committed) => {
					expect(committed).toBe(true)
					throw failure
				})
				await tx.execute('UPSERT INTO example')
			}
		)
	).rejects.toMatchObject({ committed: true, cause: failure })
	expect(calls).toBe(1)
	expect(server.commits).toHaveLength(1)
	expect(server.rollbacks).toHaveLength(0)
})

test('session loss after successful commit cannot repeat the transaction', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let calls = 0
	let closed: boolean[] = []
	await client
		.retryTransaction(
			{ signal: tc.signal, idempotent: true, retry: { budget: 2, strategy: 0 } },
			async (tx) => {
				calls++
				tx.onClose(async (committed) => {
					closed.push(committed)
					server.breakSession(tx.sessionId)
					await onAbort(tx.signal)
				})
				return 'committed'
			}
		)
		.catch(() => {})
	expect(calls).toBe(1)
	expect(closed).toEqual([true])
	expect(server.commits).toHaveLength(1)
	expect(server.rollbacks).toHaveLength(0)
})

test('caller cancellation while reading preserves its reason and does not retry', async (tc) => {
	let entered = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			entered.resolve()
			await onAbort(context.signal)
			stopped.resolve()
			yield statusPart(Status.SUCCESS)
		},
	})
	await using client = new QueryClient(server.driver)
	let caller = new AbortController()
	let reason = new Error('caller stopped')
	let operation = client
		.retrySession(
			{
				signal: caller.signal,
				idempotent: true,
				retry: { budget: 2, strategy: 0 },
			},
			(session) => session.execute('SELECT id')
		)
		.catch((error: unknown) => error)
	await abortable(tc.signal, entered.promise)
	caller.abort(reason)
	await expect(operation).resolves.toBe(reason)
	await abortable(tc.signal, stopped.promise)
	expect(server.executions).toHaveLength(1)
})

async function queryAcrossSessionDeath(idempotent: boolean, signal: AbortSignal) {
	let entered = Promise.withResolvers<string>()
	let executions = 0
	using server = await startClientServer({
		async *executeQuery(request, context) {
			if (++executions === 1) {
				entered.resolve(request.sessionId)
				await onAbort(context.signal)
				return
			}
			yield resultPart([2])
		},
	})
	await using client = new QueryClient(server.driver)
	let operation = client
		.retrySession(
			{
				signal,
				idempotent,
				retry: { budget: 2, strategy: 0 },
			},
			(session) => session.execute('SELECT id')
		)
		.catch((error: unknown) => error)
	let sessionId = await abortable(signal, entered.promise)
	server.breakSession(sessionId)
	let result = await operation
	return { result, sessions: server.executions.map((request) => request.sessionId) }
}

test('session death retries an idempotent operation with a fresh session', async (tc) => {
	let { result, sessions } = await queryAcrossSessionDeath(true, tc.signal)
	expect(result).toMatchObject({ resultSets: [{ rows: [{ id: 2 }] }] })
	expect(sessions).toHaveLength(2)
	expect(sessions[1]).not.toBe(sessions[0])
})

test('session death does not retry an operation without idempotency', async (tc) => {
	let { result, sessions } = await queryAcrossSessionDeath(false, tc.signal)
	expect(result).toBeInstanceOf(SessionAbortedError)
	expect(sessions).toHaveLength(1)
})

test('BAD_SESSION retires the failed session before the query is retried', async (tc) => {
	let executions = 0
	using server = await startClientServer({
		async *executeQuery() {
			yield ++executions === 1 ? statusPart(Status.BAD_SESSION) : resultPart([2])
		},
	})
	await using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let result = await client.retrySession(
		{
			signal: tc.signal,
			retry: { budget: 2, strategy: 0 },
		},
		(session) => session.execute('SELECT id')
	)
	expect(result.resultSets[0]!.rows).toEqual([{ id: 2 }])
	expect(server.executions).toHaveLength(2)
	expect(server.executions[1]!.sessionId).not.toBe(server.executions[0]!.sessionId)
})

test('BAD_SESSION during transaction begin retries on a fresh session', async (tc) => {
	let begins = 0
	using server = await startClientServer({
		beginTransaction() {
			return create(
				BeginTransactionResponseSchema,
				++begins === 1
					? { status: Status.BAD_SESSION }
					: { status: Status.SUCCESS, txMeta: { id: 'recovered-tx' } }
			)
		},
	})
	await using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	await client.retryTransaction(
		{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
		async (tx) => {
			await tx.execute('SELECT 1')
		}
	)
	expect(server.begins).toHaveLength(2)
	expect(server.begins[1]!.sessionId).not.toBe(server.begins[0]!.sessionId)
	expect(server.commits).toHaveLength(1)
})

test('precommit hooks finish before commit and close hooks see the committed result', async (tc) => {
	let events: string[] = []
	using server = await startClientServer({
		commitTransaction() {
			events.push('commit')
			return create(CommitTransactionResponseSchema, { status: Status.SUCCESS })
		},
	})
	await using client = new QueryClient(server.driver)
	await client.retryTransaction({ signal: tc.signal }, async (tx) => {
		tx.onCommit(async () => {
			await tx.execute('SELECT flush')
			events.push('flushed')
		})
		tx.onClose((committed) => {
			events.push(`closed:${committed}`)
		})
	})
	expect(events).toEqual(['flushed', 'commit', 'closed:true'])
})
