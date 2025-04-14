import type { Abortable } from "node:events";

import type { RetryBudget } from "./budget.js";
import type { RetryContext } from "./context.js";
import type { RetryStrategy } from "./strategy.js";

/**
 * Options for retry configuration
 */
export interface RetryConfig extends Abortable {
	/** Predicate to determine if an error is retryable */
	retry?: boolean | ((error: RetryContext['error'], idempotent: boolean) => boolean);
	/** Budget for retry attempts */
	budget?: number | RetryBudget;
	/** Strategy to calculate delay */
	strategy?: number | RetryStrategy;
	/** Idempotent operation */
	idempotent?: boolean;
};
