import type { Abortable } from 'node:events'

export interface TX extends Abortable {
	sessionId: string
	transactionId: string
	onRollback: (
		fn: (error: unknown, signal?: AbortSignal) => Promise<void> | void
	) => void
	onCommit: (fn: (signal?: AbortSignal) => Promise<void> | void) => void
	onClose: (
		fn: (committed: boolean, signal?: AbortSignal) => Promise<void> | void
	) => void
}
