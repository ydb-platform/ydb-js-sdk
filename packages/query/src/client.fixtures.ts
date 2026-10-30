import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation'
import {
	type BeginTransactionRequest,
	BeginTransactionResponseSchema,
	type CommitTransactionRequest,
	CommitTransactionResponseSchema,
	CreateSessionResponseSchema,
	DeleteSessionResponseSchema,
	type ExecuteQueryRequest,
	ExecuteQueryResponsePartSchema,
	QueryServiceDefinition,
	type RollbackTransactionRequest,
	RollbackTransactionResponseSchema,
	SessionStateSchema,
} from '@ydbjs/api/query'
import { TypeSchema, Type_PrimitiveTypeId, ValueSchema } from '@ydbjs/api/value'
import { Driver, type DriverOptions } from '@ydbjs/core'
import { Server, type ServiceImplementation } from '@ydbjs/grpc'

type QueryHandlers = ServiceImplementation<typeof QueryServiceDefinition>

export function onAbort(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve()
		signal.addEventListener('abort', () => resolve(), { once: true })
	})
}

export function resultPart(values: number[], resultSetIndex = 0) {
	return create(ExecuteQueryResponsePartSchema, {
		status: Status.SUCCESS,
		resultSetIndex: BigInt(resultSetIndex),
		resultSet: {
			columns: [
				{
					name: 'id',
					type: create(TypeSchema, {
						type: { case: 'typeId', value: Type_PrimitiveTypeId.INT32 },
					}),
				},
			],
			rows: values.map((value) =>
				create(ValueSchema, {
					items: [create(ValueSchema, { value: { case: 'int32Value', value } })],
				})
			),
		},
	})
}

export function statusPart(status: Status) {
	return create(ExecuteQueryResponsePartSchema, { status })
}

// A real gRPC boundary with controlled failures and attach-stream lifetimes.
export async function startClientServer(
	handlers: Partial<QueryHandlers> = {},
	driverOptions: DriverOptions = {}
) {
	let sessions = new Map<string, AbortController>()
	let executions: ExecuteQueryRequest[] = []
	let begins: BeginTransactionRequest[] = []
	let commits: CommitTransactionRequest[] = []
	let rollbacks: RollbackTransactionRequest[] = []
	let deleted: string[] = []
	let nextId = 0
	let nextTx = 0
	let server = new Server()
	server.add(QueryServiceDefinition, {
		createSession() {
			let sessionId = `client-session-${++nextId}`
			sessions.set(sessionId, new AbortController())
			return create(CreateSessionResponseSchema, {
				status: Status.SUCCESS,
				sessionId,
				nodeId: 0n,
			})
		},
		async *attachSession(request, context) {
			if (handlers.attachSession) {
				yield* handlers.attachSession(request, context)
				return
			}
			let controller = sessions.get(request.sessionId)!
			yield create(SessionStateSchema, { status: Status.SUCCESS })
			await Promise.race([onAbort(controller.signal), onAbort(context.signal)])
		},
		deleteSession(request) {
			deleted.push(request.sessionId)
			sessions.get(request.sessionId)?.abort()
			return create(DeleteSessionResponseSchema, { status: Status.SUCCESS })
		},
		async *executeQuery(request, context) {
			executions.push(request)
			if (handlers.executeQuery) yield* handlers.executeQuery(request, context)
			else yield resultPart([1])
		},
		beginTransaction(request, context) {
			begins.push(request)
			return (
				handlers.beginTransaction?.(request, context) ??
				create(BeginTransactionResponseSchema, {
					status: Status.SUCCESS,
					txMeta: { id: `client-tx-${++nextTx}` },
				})
			)
		},
		commitTransaction(request, context) {
			commits.push(request)
			return (
				handlers.commitTransaction?.(request, context) ??
				create(CommitTransactionResponseSchema, { status: Status.SUCCESS })
			)
		},
		rollbackTransaction(request, context) {
			rollbacks.push(request)
			return (
				handlers.rollbackTransaction?.(request, context) ??
				create(RollbackTransactionResponseSchema, { status: Status.SUCCESS })
			)
		},
	})
	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		...driverOptions,
		'ydb.sdk.enable_discovery': false,
	})
	return {
		driver,
		server,
		executions,
		begins,
		commits,
		rollbacks,
		deleted,
		breakSession(id: string) {
			sessions.get(id)!.abort()
		},
		[Symbol.dispose]() {
			for (let controller of sessions.values()) controller.abort()
			driver.close()
			server[Symbol.dispose]()
		},
	}
}
