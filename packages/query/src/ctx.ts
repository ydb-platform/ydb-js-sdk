import { AsyncLocalStorage } from "node:async_hooks";
import type { Abortable } from "node:events";

type Context = Abortable & {
	nodeId?: bigint;
	sessionId?: string;
	transactionId?: string;
}

export const ctx = new AsyncLocalStorage<Context>()
