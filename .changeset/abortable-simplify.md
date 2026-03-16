---
'@ydbjs/abortable': minor
---

Add linkSignals utility and simplify abortable implementation

- Add new `linkSignals` function to combine multiple AbortSignal instances
- Simplify abortable implementation to use native AbortSignal API
- Improve type safety and reduce code complexity
- Add comprehensive tests for signal linking and cleanup
