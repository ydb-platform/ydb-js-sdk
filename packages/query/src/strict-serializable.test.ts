import { afterEach, expect, test } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import { createServer } from 'nice-grpc'

import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	BeginTransactionResponseSchema,
	CommitTransactionResponseSchema,
	CreateSessionResponseSchema,
	DeleteSessionResponseSchema,
	type ExecuteQueryResponsePart,
	ExecuteQueryResponsePartSchema,
	QueryServiceDefinition,
	SessionStateSchema,
	TransactionSettingsSchema,
} from '@ydbjs/api/query'

import { query } from './index.js'
import { virtualTimestampFromProto } from './virtual-timestamp.js'

async function startServer() {
	let executeParts: ExecuteQueryResponsePart[] = []
	let commitTimestamp: { planStep: bigint; txId: bigint } | undefined
	let beginModes: Array<string | undefined> = []
	let executeModes: Array<string | undefined> = []
	let server = createServer()
	server.add(
		{
			createSession: QueryServiceDefinition.createSession,
			deleteSession: QueryServiceDefinition.deleteSession,
			attachSession: QueryServiceDefinition.attachSession,
			beginTransaction: QueryServiceDefinition.beginTransaction,
			commitTransaction: QueryServiceDefinition.commitTransaction,
			executeQuery: QueryServiceDefinition.executeQuery,
		},
		{
			async createSession() {
				return create(CreateSessionResponseSchema, {
					status: StatusIds_StatusCode.SUCCESS,
					sessionId: 'session-1',
					nodeId: 1n,
				})
			},
			async deleteSession() {
				return create(DeleteSessionResponseSchema, { status: StatusIds_StatusCode.SUCCESS })
			},
			async *attachSession(_request, context) {
				yield create(SessionStateSchema, { status: StatusIds_StatusCode.SUCCESS })
				await new Promise<void>((resolve) => {
					context.signal.addEventListener('abort', () => resolve(), { once: true })
				})
			},
			async beginTransaction(request) {
				beginModes.push(request.txSettings?.txMode.case)
				return create(BeginTransactionResponseSchema, {
					status: StatusIds_StatusCode.SUCCESS,
					txMeta: { id: 'tx-1' },
				})
			},
			async commitTransaction() {
				return create(CommitTransactionResponseSchema, {
					status: StatusIds_StatusCode.SUCCESS,
					commitTimestamp,
				})
			},
			async *executeQuery(request) {
				executeModes.push(
					request.txControl?.txSelector.case === 'beginTx'
						? request.txControl.txSelector.value.txMode.case
						: undefined
				)
				for (let responsePart of executeParts) yield responsePart
			},
		}
	)
	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	return {
		driver,
		beginModes,
		executeModes,
		setExecuteParts(parts: ExecuteQueryResponsePart[]) {
			executeParts = parts
		},
		setCommitTimestamp(value: typeof commitTimestamp) {
			commitTimestamp = value
		},
		async close() {
			driver.close()
			await server.shutdown()
		},
	}
}

type Server = Awaited<ReturnType<typeof startServer>>
let srv: Server | undefined

afterEach(async () => {
	await srv?.close()
	srv = undefined
})

function part(commitTimestamp?: { planStep: bigint; txId: bigint }): ExecuteQueryResponsePart {
	return create(ExecuteQueryResponsePartSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		commitTimestamp,
	})
}

test('sends StrictSerializableRW for explicit and single-query transactions', async () => {
	srv = await startServer()
	srv.setExecuteParts([part()])
	await using sql = query(srv.driver)

	await sql.begin({ isolation: 'strictSerializableReadWrite' }, async (tx) => {
		await tx`SELECT 1`
	})
	await sql`SELECT 1`.isolation('strictSerializableReadWrite')

	expect(srv.beginModes).toEqual(['strictSerializableReadWrite'])
	expect(srv.executeModes).toEqual([undefined, 'strictSerializableReadWrite'])
})

test('encodes the StrictSerializableRW and commit timestamp protobuf fields', () => {
	let mode = create(TransactionSettingsSchema, {
		txMode: { case: 'strictSerializableReadWrite', value: {} },
	})
	let commit = create(CommitTransactionResponseSchema, {
		commitTimestamp: { planStep: 1n, txId: 2n },
	})
	let execute = create(ExecuteQueryResponsePartSchema, {
		commitTimestamp: { planStep: 1n, txId: 2n },
	})

	expect(toBinary(TransactionSettingsSchema, mode)[0]).toBe((7 << 3) | 2)
	expect(toBinary(CommitTransactionResponseSchema, commit)[0]).toBe((3 << 3) | 2)
	expect(toBinary(ExecuteQueryResponsePartSchema, execute)[0]).toBe((8 << 3) | 2)
})

test('returns commit timestamp from CommitTransactionResponse without changing begin result', async () => {
	srv = await startServer()
	srv.setCommitTimestamp({ planStep: 9007199254740993n, txId: 18446744073709551615n })
	await using sql = query(srv.driver)

	let commit = await sql.beginWithTimestamp(
		{ isolation: 'strictSerializableReadWrite' },
		async () => 42
	)
	let result = await sql.begin({ isolation: 'strictSerializableReadWrite' }, async () => 42)

	expect(commit.result).toBe(42)
	expect(commit.commitTimestamp).toMatchObject({
		planStep: 9007199254740993n,
		txId: 18446744073709551615n,
	})
	expect(result).toBe(42)
})

test('leaves commit timestamp absent when the commit response omits it', async () => {
	srv = await startServer()
	await using sql = query(srv.driver)

	let commit = await sql.transactionWithTimestamp(
		{ isolation: 'strictSerializableReadWrite' },
		async () => 1
	)
	expect(commit).toEqual({ result: 1 })
})

test('returns only the final trailing ExecuteQuery timestamp', async () => {
	srv = await startServer()
	srv.setExecuteParts([
		part({ planStep: 1n, txId: 1n }),
		part({ planStep: 9007199254740993n, txId: 2n }),
	])
	await using sql = query(srv.driver)
	let q = sql`UPSERT INTO t ...`.isolation('strictSerializableReadWrite')
	await q
	expect(q.commitTimestamp()).toMatchObject({ planStep: 9007199254740993n, txId: 2n })
})

test('does not use a timestamp from an earlier response part', async () => {
	srv = await startServer()
	srv.setExecuteParts([part({ planStep: 1n, txId: 1n }), part()])
	await using sql = query(srv.driver)
	let q = sql`SELECT 1`.isolation('strictSerializableReadWrite')
	await q
	expect(q.commitTimestamp()).toBeUndefined()
})

test('returns the timestamp when the final trailing part also has a result set', async () => {
	srv = await startServer()
	srv.setExecuteParts([
		part({ planStep: 1n, txId: 1n }),
		create(ExecuteQueryResponsePartSchema, {
			status: StatusIds_StatusCode.SUCCESS,
			resultSet: {},
			commitTimestamp: { planStep: 2n, txId: 3n },
		}),
	])
	await using sql = query(srv.driver)
	let write = sql`UPSERT INTO t ...; SELECT 1`.isolation('strictSerializableReadWrite')
	expect(await write).toEqual([[]])
	expect(write.commitTimestamp()).toMatchObject({ planStep: 2n, txId: 3n })
})

test('does not use a timestamp from another isolation mode', async () => {
	srv = await startServer()
	srv.setExecuteParts([part({ planStep: 2n, txId: 2n })])
	await using sql = query(srv.driver)
	let ordinary = sql`SELECT 1`
	await ordinary
	expect(ordinary.commitTimestamp()).toBeUndefined()
})

test('does not expose a timestamp when a later query part fails', async () => {
	srv = await startServer()
	srv.setExecuteParts([
		part({ planStep: 1n, txId: 1n }),
		create(ExecuteQueryResponsePartSchema, {
			status: StatusIds_StatusCode.BAD_REQUEST,
			commitTimestamp: { planStep: 2n, txId: 2n },
		}),
	])
	await using sql = query(srv.driver)
	let q = sql`SELECT 1`.isolation('strictSerializableReadWrite')
	q.on('error', () => {})
	await expect(Promise.resolve(q)).rejects.toBeInstanceOf(YDBError)
	expect(q.commitTimestamp()).toBeUndefined()
})

test('compares unsigned uint64 timestamps lexicographically and rejects another Driver', () => {
	let driver = { database: '/local', address: 'localhost' }
	let otherDriver = { database: '/other', address: 'localhost' }
	let anotherDriverForSameDatabase = { database: '/local', address: 'localhost' }
	let low = virtualTimestampFromProto(
		{ planStep: 9007199254740993n, txId: 18446744073709551615n },
		driver
	)!
	let high = virtualTimestampFromProto({ planStep: 9007199254740994n, txId: 0n }, driver)!
	let sameStep = virtualTimestampFromProto({ planStep: low.planStep, txId: 1n }, driver)!
	let equal = virtualTimestampFromProto({ planStep: low.planStep, txId: low.txId }, driver)!
	let foreign = virtualTimestampFromProto(
		{ planStep: low.planStep, txId: low.txId },
		otherDriver
	)!
	let separate = virtualTimestampFromProto(
		{ planStep: low.planStep, txId: low.txId },
		anotherDriverForSameDatabase
	)!

	expect(low.compare(high)).toBe(-1)
	expect(high.compare(low)).toBe(1)
	expect(sameStep.compare(low)).toBe(-1)
	expect(low.compare(sameStep)).toBe(1)
	expect(low.compare(equal)).toBe(0)
	expect(() => low.compare(foreign)).toThrow('same Driver')
	expect(() => low.compare(separate)).toThrow('same Driver')
	expect(() =>
		low.compare({ planStep: low.planStep, txId: low.txId, compare: low.compare })
	).toThrow('same Driver')
})

test('rejects timestamps outside the unsigned 64-bit range', () => {
	let driver = { database: '/local', address: 'localhost' }
	let beyondUint64 = 1n << 64n
	for (let value of [
		{ planStep: -1n, txId: 0n },
		{ planStep: beyondUint64, txId: 0n },
		{ planStep: 0n, txId: -1n },
		{ planStep: 0n, txId: beyondUint64 },
	]) {
		expect(() => virtualTimestampFromProto(value, driver)).toThrow('uint64')
	}
})
