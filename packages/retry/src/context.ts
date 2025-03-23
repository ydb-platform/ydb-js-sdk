/**
 * Context for retry operation
 */
export type RetryContext = {
	attempt: number;
	error: unknown;
}
