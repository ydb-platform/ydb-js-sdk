---
'@ydbjs/fsm': patch
---

Fix memory leak in event ingestion caused by `AbortSignal.any()`

`AbortSignal.any()` registers event listeners on all source signals but never removes them, leading to a listener leak every time an event source is ingested. Replace it with `linkSignals` from `@ydbjs/abortable@^6.1.0`, which uses `Symbol.dispose` to clean up listeners when the ingestion task completes.

Additional improvements:

- Use `combined.signal` instead of `combined` directly for abort checks (correct API usage)
- Separate abort signal checks from internal state checks for better readability and clearer control flow
