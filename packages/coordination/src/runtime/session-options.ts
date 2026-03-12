export interface CoordinationSessionOptions {
	path: string
	description?: string
	recoveryWindow?: number
	startTimeout?: number
	retryBackoff?: number
}
