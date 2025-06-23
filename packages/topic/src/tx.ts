export type TX = {
	sessionId: string
	transactionId: string
	registerPrecommitHook: (fn: () => Promise<void> | void) => void
}
