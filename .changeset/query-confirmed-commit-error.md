---
'@ydbjs/error': minor
'@ydbjs/retry': patch
'@ydbjs/query': major
---

Report failed completion hooks after a confirmed commit as TransactionCompletionError, with committed=true and the original cause. Preserve this terminal classification across enclosing SDK retriers instead of exposing a retryable database error for an already committed transaction.

Release SDK resources when cancellation interrupts application cleanup hooks. Preserve confirmed commit information on cancellation, and wrap retryable database errors used as cancellation reasons in AbortError with the original cause so enclosing callbacks cannot replay them.
