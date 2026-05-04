import { AsyncLocalStorage } from 'node:async_hooks'
import type { Abortable } from 'node:events'

import type { Session } from './session.js'

/**
 * Async-local context carried across an `sql.begin()` body. The Session
 * instance is the source of truth for `sessionId` / `nodeId`; we don't
 * duplicate them here. `transactionId` is the only piece that's not
 * derivable from Session — it's per-attempt of the tx body.
 */
type Context = Abortable & {
	session?: Session
	transactionId?: string
}

export const ctx = new AsyncLocalStorage<Context>()
