import { AsyncLocalStorage } from "node:async_hooks";

type Store = {
	nodeId?: bigint;
	sessionId?: string;
	transactionId?: string;
}

export const storage = new AsyncLocalStorage<Store>()
