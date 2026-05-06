import { safeTracingSubscribe } from '../safe.js'
import { SpanKind } from '../tracing.js'
import type { TracingSetup } from '../context-manager.js'

type ExecuteCtx = {
	text: string
	sessionId: string
	nodeId: bigint
	idempotent: boolean
	isolation: string
	stage: string
	error?: unknown
}

type TransactionCtx = {
	isolation: string
	idempotent: boolean
	error?: unknown
}

type CommitCtx = { sessionId: string; transactionId: string; error?: unknown }
type RollbackCtx = { sessionId: string; transactionId: string; error?: unknown }

export type QueryTracingOptions = {
	/** When true, db.query.text is set to the actual query text; otherwise '<redacted>'. */
	captureQueryText?: boolean
}

export function subscribeQueryTracing(
	setup: TracingSetup,
	options: QueryTracingOptions = {}
): () => void {
	let { enter, enterLeaf, finishOk, finishError, noop, base } = setup
	let captureQueryText = options.captureQueryText ?? false

	let unsubExecute = safeTracingSubscribe<ExecuteCtx>('tracing:ydb:query.execute', {
		start(ctx) {
			enterLeaf(ctx, 'ydb.ExecuteQuery', {
				kind: SpanKind.CLIENT,
				attributes: {
					...base,
					'db.operation.name': 'ExecuteQuery',
					'db.query.text': captureQueryText ? ctx.text : '<redacted>',
					'db.ydb.session_id': ctx.sessionId,
					'db.ydb.node_id': Number(ctx.nodeId),
					'ydb.idempotent': ctx.idempotent,
					'ydb.isolation': ctx.isolation,
					'ydb.stage': ctx.stage,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	// Transaction IS a scope: ExecuteQuery, Commit, Rollback fired inside its channel body
	// become its children because Transaction pushes itself onto spanStorage.
	let unsubTransaction = safeTracingSubscribe<TransactionCtx>('tracing:ydb:query.transaction', {
		start(ctx) {
			enter(ctx, 'ydb.Transaction', {
				kind: SpanKind.CLIENT,
				attributes: {
					...base,
					'db.operation.name': 'Transaction',
					'ydb.isolation': ctx.isolation,
					'ydb.idempotent': ctx.idempotent,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	let unsubCommit = safeTracingSubscribe<CommitCtx>('tracing:ydb:query.commit', {
		start(ctx) {
			enterLeaf(ctx, 'ydb.Commit', {
				kind: SpanKind.CLIENT,
				attributes: {
					...base,
					'db.operation.name': 'CommitTransaction',
					'db.ydb.session_id': ctx.sessionId,
					'ydb.transaction.id': ctx.transactionId,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	let unsubRollback = safeTracingSubscribe<RollbackCtx>('tracing:ydb:query.rollback', {
		start(ctx) {
			enterLeaf(ctx, 'ydb.Rollback', {
				kind: SpanKind.CLIENT,
				attributes: {
					...base,
					'db.operation.name': 'RollbackTransaction',
					'db.ydb.session_id': ctx.sessionId,
					'ydb.transaction.id': ctx.transactionId,
				},
			})
		},
		end: noop,
		asyncStart: noop,
		asyncEnd: finishOk,
		error: finishError,
	})

	return () => {
		unsubExecute()
		unsubTransaction()
		unsubCommit()
		unsubRollback()
	}
}
