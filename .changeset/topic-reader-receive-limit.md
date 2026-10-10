---
'@ydbjs/topic': patch
---

Report oversized gRPC read responses as terminal errors instead of repeatedly reconnecting to the same unread message. Temporary resource exhaustion remains retryable.
