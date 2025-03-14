import type { RetryBudget } from "./budget.js";
import type { RetryContext } from "./context.js";
import type { RetryStrategy } from "./strategy.js";

/**
 * Options for retry configuration
 */
export interface RetryConfig {
    /** Idempotent operation */
    idempotent?: boolean;
    /** Predicate to determine if an error is retryable */
    retry?: (error: RetryContext['error']) => boolean;
    /** Budget for retry attempts */
    budget?: number | RetryBudget;
    /** Strategy to calculate delay */
    strategy?: number | RetryStrategy;
};
