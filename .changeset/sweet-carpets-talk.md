---
'@ydbjs/retry': patch
---

- Refined retry logic: now throws the original AbortError, supports AbortSignal, and adds onRetry hook.
- Expanded configuration options and documentation.
- Improved test coverage for retry scenarios.
