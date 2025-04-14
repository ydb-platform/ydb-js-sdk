import { AsyncLocalStorage } from "node:async_hooks";
import type { Abortable } from "node:events";

type Store = Abortable & {
	nodeId?: bigint;
	sessionId?: string;
	transactionId?: string;
}

export const storage = new AsyncLocalStorage<Store>()
