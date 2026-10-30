import { expect, test, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import {
	CommitTransactionResponseSchema,
	QueryServiceDefinition,
	RollbackTransactionResponseSchema,
} from '@ydbjs/api/query'
import { ProtocolError, RpcError, Status as RpcStatus } from '@ydbjs/grpc'
import { YDBError } from '@ydbjs/error'
import { Int32 } from '@ydbjs/value/primitive'

import { type OperationOptions, QueryClient } from './client.ts'
import { onAbort, resultPart, startClientServer, statusPart } from './client.fixtures.ts'
import { query } from './index.ts'

test('a confirmed commit cannot be replayed by an enclosing SDK retrier', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver, { poolOptions: { maxSize: 2 } })
	let cause = new YDBError(Status.ABORTED, [])
	let result = client.retrySession(
		{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
		async () => {
			return client.retryTransaction({ signal: tc.signal }, async (tx) => {
				await tx.execute('UPDATE counter SET value = value + 1')
				tx.onClose(() => {
					throw cause
				})
			})
		}
	)
	await expect(result).rejects.toMatchObject({ committed: true, cause })
	expect(server.commits).toHaveLength(1)
	expect(server.executions).toHaveLength(1)
})

test('a metadata observer error cannot replay an already completed server operation', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let cause = new YDBError(Status.ABORTED, [])
	let failure = await client
		.retrySession(
			{ signal: tc.signal, idempotent: true, retry: { budget: 3, strategy: 0 } },
			(session) =>
				session.execute(
					'SELECT 1',
					{},
					{
						onMetadata: () => {
							throw cause
						},
					}
				)
		)
		.catch((error: unknown) => error)
	expect(failure).toMatchObject({ message: 'Query metadata observer failed.', cause })
	expect(server.executions).toHaveLength(1)
})

test('callback executors do not expose mutable transaction internals', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	await client.retrySession({ signal: tc.signal }, async (session) => {
		expect('onCommit' in session).toBe(false)
		expect(Reflect.set(session, 'sessionId', 'foreign')).toBe(false)
		let execute = session.execute
		await execute('SELECT session')
		expect(server.executions.at(-1)?.sessionId).toBe(session.sessionId)
	})
	await client.retryTransaction({ signal: tc.signal }, async (tx) => {
		expect(Reflect.set(tx, 'transactionId', 'foreign')).toBe(false)
		expect(Reflect.set(tx, 'nodeId', 999n)).toBe(false)
		expect('commitHooks' in tx).toBe(false)
		let execute = tx.execute
		await execute('SELECT transaction')
		expect(server.executions.at(-1)?.txControl?.txSelector).toEqual({
			case: 'txId',
			value: tx.transactionId,
		})
	})
})

test('mutating operation options after admission cannot enable retries for an uncertain write', async (tc) => {
	using server = await startClientServer({
		async *executeQuery() {
			yield await Promise.reject(new RpcError(RpcStatus.UNAVAILABLE, 'write response lost'))
		},
	})
	await using client = new QueryClient(server.driver)
	let options: OperationOptions = {
		signal: tc.signal,
		idempotent: false,
		retry: { budget: 2, strategy: 0 },
	}
	let operation = client.retrySession(options, (session) =>
		session.execute('UPSERT INTO example')
	)
	options.idempotent = true
	await expect(operation).rejects.toMatchObject({ code: RpcStatus.UNAVAILABLE })
	expect(server.executions).toHaveLength(1)
})

test('retrySession reexecutes its callback with current byte parameters', async (tc) => {
	let payload = new Uint8Array([1, 2, 3])
	let executions = 0
	using server = await startClientServer({
		async *executeQuery() {
			yield ++executions === 1 ? statusPart(Status.OVERLOADED) : resultPart([1])
		},
	})
	await using client = new QueryClient(server.driver)
	await client.retrySession(
		{
			signal: tc.signal,
			retry: { budget: 2, strategy: 0 },
			onRetry() {
				payload[0] = 9
			},
		},
		(session) => session.execute('SELECT $payload', { payload })
	)
	expect(server.executions).toHaveLength(2)
	let received = server.executions.map((request) => {
		let value = request.parameters.$payload?.value?.value
		return value?.case === 'bytesValue' ? Array.from(value.value) : undefined
	})
	expect(received).toEqual([
		[1, 2, 3],
		[9, 2, 3],
	])
})

test('retrySession reencodes typed parameters on each callback attempt', async (tc) => {
	let id = new Int32(1)
	let executions = 0
	using server = await startClientServer({
		async *executeQuery() {
			yield ++executions === 1 ? statusPart(Status.OVERLOADED) : resultPart([1])
		},
	})
	await using client = new QueryClient(server.driver)
	await client.retrySession(
		{
			signal: tc.signal,
			retry: { budget: 2, strategy: 0 },
			onRetry() {
				id.encode().value = { case: 'int32Value', value: 9 }
			},
		},
		(session) => session.execute('SELECT $id', { id })
	)
	expect(server.executions.map((request) => request.parameters.$id?.value?.value)).toEqual([
		{ case: 'int32Value', value: 1 },
		{ case: 'int32Value', value: 9 },
	])
	expect(server.executions).toHaveLength(2)
})

test('a scoped statement snapshots byte and typed parameters before consumption', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let payload = Buffer.from([1, 2, 3])
	let id = new Int32(1)
	await client.retrySession({ signal: tc.signal }, async (session) => {
		let stream = session.stream('SELECT $payload, $id', { payload, id })
		payload[0] = 9
		id.encode().value = { case: 'int32Value', value: 9 }
		for await (let part of stream) expect(part.rows).toEqual([{ id: 1 }])
	})
	expect(server.executions).toHaveLength(1)
	let request = server.executions[0]!
	let bytes = request.parameters.$payload?.value?.value
	expect(bytes?.case === 'bytesValue' ? Array.from(bytes.value) : undefined).toEqual([1, 2, 3])
	expect(request.parameters.$id?.value?.value).toEqual({ case: 'int32Value', value: 1 })
})

test('a tagged query preserves bound byte and typed parameters across retries', async (tc) => {
	let payload = Buffer.from([1, 2, 3])
	let id = new Int32(1)
	let executions = 0
	using server = await startClientServer({
		async *executeQuery() {
			yield ++executions === 1 ? statusPart(Status.OVERLOADED) : resultPart([1])
		},
	})
	await using client = new QueryClient(server.driver)
	let sql = query(client)
	let statement = sql`SELECT ${payload}, ${id}`.signal(tc.signal)
	statement.on('retry', () => {
		payload[0] = 9
		id.encode().value = { case: 'int32Value', value: 9 }
	})
	await statement
	expect(server.executions).toHaveLength(2)
	for (let request of server.executions) {
		let values = Object.values(request.parameters).map((parameter) => parameter.value?.value)
		let bytes = values.find((value) => value?.case === 'bytesValue')
		expect(bytes?.case === 'bytesValue' ? Array.from(bytes.value) : undefined).toEqual([
			1, 2, 3,
		])
		expect(values).toContainEqual({ case: 'int32Value', value: 1 })
	}
})

test('catching a statement failure cannot commit or complete the failed transaction attempt', async (tc) => {
	let executions = 0
	using server = await startClientServer({
		async *executeQuery() {
			yield ++executions === 1 ? statusPart(Status.ABORTED) : resultPart([1])
		},
	})
	await using client = new QueryClient(server.driver)
	let callbacks = 0
	let result = await client.retryTransaction(
		{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
		async (transaction) => {
			callbacks++
			await transaction.execute('UPDATE data').catch(() => undefined)
			return callbacks
		}
	)
	expect(result).toBe(2)
	expect(server.executions).toHaveLength(2)
	expect(server.commits).toHaveLength(1)
	expect(server.executions[1]!.txControl?.txSelector).toEqual({
		case: 'txId',
		value: server.commits[0]!.txId,
	})
})

test('precommit preparation cannot silently add a hook that will never run', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	await expect(
		client.retryTransaction({ signal: tc.signal }, async (transaction) => {
			transaction.beforeCommit(() => {
				transaction.beforeCommit(() => {})
			})
		})
	).rejects.toThrow('Commit hooks have already started')
	expect(server.commits).toHaveLength(0)
	expect(server.rollbacks).toHaveLength(1)
})

test('synchronous precommit failure still observes failures from already-started hooks', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let failure = new Error('preparation failed')
	await expect(
		client.retryTransaction({ signal: tc.signal }, async (transaction) => {
			transaction.beforeCommit(() => Promise.reject(failure))
			transaction.beforeCommit(() => {
				throw failure
			})
		})
	).rejects.toBe(failure)
	expect(server.commits).toHaveLength(0)
})

test('a close hook cannot send new statements after the transaction has committed', async (tc) => {
	let committed = false
	using server = await startClientServer({
		commitTransaction() {
			committed = true
			return create(CommitTransactionResponseSchema, { status: Status.SUCCESS })
		},
		async *executeQuery() {
			yield committed ? statusPart(Status.NOT_FOUND) : resultPart([1])
		},
	})
	await using client = new QueryClient(server.driver)
	let callbacks = 0
	await expect(
		client.retryTransaction(
			{ signal: tc.signal, idempotent: true, retry: { budget: 2, strategy: 0 } },
			async (transaction) => {
				callbacks++
				transaction.onClose(async () => {
					await transaction.execute('UPSERT INTO after_commit')
				})
			}
		)
	).rejects.toThrow(/ended|committed|closed/)
	expect(callbacks).toBe(1)
	expect(server.commits).toHaveLength(1)
	expect(server.executions).toHaveLength(0)
})

test('a confirmed commit stays successful when its session ends during close hooks', async (tc) => {
	using server = await startClientServer()
	await using client = new QueryClient(server.driver)
	let callbacks = 0
	let result = await client.retryTransaction(
		{ signal: tc.signal, idempotent: true, retry: { budget: 2, strategy: 0 } },
		async (transaction) => {
			callbacks++
			transaction.onClose(async (committed) => {
				expect(committed).toBe(true)
				server.breakSession(transaction.sessionId)
				await onAbort(transaction.signal)
			})
			return 'committed result'
		}
	)
	expect(result).toBe('committed result')
	expect(callbacks).toBe(1)
	expect(server.commits).toHaveLength(1)
	expect(server.rollbacks).toHaveLength(0)
})

test('an unknown commit outcome remains a transport error after rollback reports NOT_FOUND', async (tc) => {
	using server = await startClientServer({
		commitTransaction() {
			throw new RpcError(RpcStatus.UNAVAILABLE, 'commit response lost')
		},
		rollbackTransaction() {
			return create(RollbackTransactionResponseSchema, { status: Status.NOT_FOUND })
		},
	})
	await using client = new QueryClient(server.driver)
	let callbacks = 0
	await expect(
		client.retryTransaction(
			{ signal: tc.signal, retry: { budget: 2, strategy: 0 } },
			async () => {
				callbacks++
			}
		)
	).rejects.toMatchObject({ code: RpcStatus.UNAVAILABLE, message: 'commit response lost' })
	expect(callbacks).toBe(1)
	expect(server.begins).toHaveLength(1)
	expect(server.commits).toHaveLength(1)
	expect(server.rollbacks).toHaveLength(1)
})

test('retrying an idempotent uncertain commit reexecutes the whole transaction on a fresh session', async (tc) => {
	let commits = 0
	using server = await startClientServer({
		commitTransaction() {
			if (++commits === 1) throw new RpcError(RpcStatus.UNAVAILABLE, 'commit response lost')
			return create(CommitTransactionResponseSchema, { status: Status.SUCCESS })
		},
	})
	await using client = new QueryClient(server.driver)
	let callbacks = 0
	await client.retryTransaction(
		{ signal: tc.signal, idempotent: true, retry: { budget: 2, strategy: 0 } },
		async (transaction) => {
			callbacks++
			await transaction.execute('UPSERT INTO idempotent_write')
		}
	)
	expect(callbacks).toBe(2)
	expect(server.begins).toHaveLength(2)
	expect(server.executions).toHaveLength(2)
	expect(server.commits).toHaveLength(2)
	expect(server.begins[1]!.sessionId).not.toBe(server.begins[0]!.sessionId)
	expect(server.commits[1]!.txId).not.toBe(server.commits[0]!.txId)
})

test('malformed response protobuf is not retried or replaced by session invalidation', async (tc) => {
	// Corrupt only response bytes so the real transport and protobuf decoder report the failure.
	let serializer = vi.spyOn(QueryServiceDefinition.executeQuery, 'responseSerialize')
	serializer.mockReturnValue(new Uint8Array([0xff]))
	try {
		using server = await startClientServer()
		await using client = new QueryClient(server.driver)
		let failure = await client
			.retrySession(
				{
					signal: tc.signal,
					idempotent: true,
					retry: { budget: 2, strategy: 0 },
				},
				(session) => session.execute('SELECT 1')
			)
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ProtocolError)
		expect(failure).toMatchObject({
			message: 'Response deserialization failed',
			cause: expect.any(Error),
		})
		expect(server.executions).toHaveLength(1)
	} finally {
		serializer.mockRestore()
	}
})

test('session death releases a scoped stream without another consumer read', async (tc) => {
	let stopped = Promise.withResolvers<void>()
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			yield resultPart([1])
			await onAbort(context.signal)
			stopped.resolve()
		},
	})
	await using client = new QueryClient(server.driver)
	await expect(
		client.retrySession({ signal: tc.signal, retry: { budget: 1 } }, async (session) => {
			let stream = session.stream('SELECT id')
			await stream.next()
			server.breakSession(server.executions[0]!.sessionId)
			await abortable(tc.signal, stopped.promise)
			session.signal.throwIfAborted()
		})
	).rejects.toMatchObject({ name: 'SessionAbortedError' })
	await abortable(tc.signal, client.close())
})

test('legacy ambient transactions cannot capture another client or explicit core calls', async (tc) => {
	using server = await startClientServer()
	await using first = new QueryClient(server.driver, { poolOptions: { maxSize: 2 } })
	await using second = new QueryClient(server.driver)
	let sql = query(first)
	let otherSQL = query(second)
	let txId = await sql.begin({ signal: tc.signal }, async (transaction) => {
		await otherSQL`SELECT other_client`
		await first.retrySession(
			{
				signal: tc.signal,
			},
			(session) => session.execute('SELECT explicit_core')
		)
		await sql`SELECT ambient_transaction`
		return transaction.transactionId
	})
	expect(server.executions).toHaveLength(3)
	expect(server.executions[0]!.txControl).toBeUndefined()
	expect(server.executions[1]!.txControl).toBeUndefined()
	expect(server.executions[2]!.txControl?.txSelector).toEqual({ case: 'txId', value: txId })
	expect(server.executions[1]!.sessionId).not.toBe(server.executions[2]!.sessionId)
})

test('legacy query cancellation preserves an arbitrary caller abort reason', async (tc) => {
	let entered = Promise.withResolvers<void>()
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			entered.resolve()
			await onAbort(context.signal)
			yield statusPart(Status.SUCCESS)
		},
	})
	await using client = new QueryClient(server.driver)
	let sql = query(client)
	let caller = new AbortController()
	let reason = { cancelled: 'request ended' }
	let operation = Promise.resolve(sql`SELECT id`.signal(caller.signal)).catch(
		(error: unknown) => error
	)
	await abortable(tc.signal, entered.promise)
	caller.abort(reason)
	await expect(operation).resolves.toBe(reason)
	expect(server.executions).toHaveLength(1)
})
