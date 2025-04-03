import type { RetryConfig } from "./config.js";
import type { RetryContext } from "./context.js";

export interface RetryBudget {
	(ctx: RetryContext, cfg: RetryConfig): number
}
