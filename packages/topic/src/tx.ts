import type { Abortable } from 'node:events'

export interface TX extends Abortable {
	sessionId: string
	transactionId: string
	// Node hosting the transaction's session. Unary tx RPCs (UpdateOffsetsInTransaction)
	// must land on this node — the session does not exist elsewhere.
	nodeId?: bigint
	onRollback: (fn: (error: unknown, signal?: AbortSignal) => Promise<void> | void) => void
	onCommit: (fn: (signal?: AbortSignal) => Promise<void> | void) => void
	onClose: (fn: (committed: boolean, signal?: AbortSignal) => Promise<void> | void) => void
}
