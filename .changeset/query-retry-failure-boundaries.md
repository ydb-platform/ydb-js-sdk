---
'@ydbjs/grpc': minor
'@ydbjs/retry': patch
---

Distinguish local protocol failures and HTTP/2 transport failures from server gRPC statuses. Stop retrying deterministic message-size and encoding failures (#586), and require idempotency before retrying ambiguous INTERNAL statuses or transport overload resets. Preserve the caller's cancellation reason and notify retry observers for attempts without backoff.
