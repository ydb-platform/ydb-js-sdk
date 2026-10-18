---
'@ydbjs/core': patch
---

Apply `ydb.sdk.token_timeout_ms` to each caller's wait for credentials before RPCs and through the `token` getter. Preserve the original RPC deadline and caller abort reason without forwarding RPC cancellation to shared provider work. Closing the Driver cancels its token waits. Already-fulfilled token promises do not allocate a token-wait timer. Measure the token-wait duration with a monotonic clock so system-clock changes cannot extend or shorten the configured budget.
