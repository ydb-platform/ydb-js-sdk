---
'@ydbjs/query': minor
---

Add graceful `QueryClient.close()` and immediate `destroy()`. Async disposal drains accepted queries, transactions and session cleanup; synchronous disposal cancels owned work without closing the shared Driver. Release query resources after failed readiness and destruction, and prevent late cleanup RPCs or callbacks after shutdown.

Keep actual query and transaction attempts owned until their cleanup completes, even when caller cancellation has already rejected the retry wrapper. Graceful close waits for rollback and close hooks; destroy still cancels them immediately.
