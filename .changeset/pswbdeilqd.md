---
'@ydbjs/retry': minor
---

Fix memory leak in retry loop caused by `AbortSignal.any()`

`AbortSignal.any()` registers event listeners on all source signals but never removes them, leading to a listener leak on every retry attempt. Replace it with `linkSignals` from `@ydbjs/abortable@^6.1.0`, which uses `Symbol.dispose` to clean up listeners immediately after each attempt via `using`.

Additional correctness fixes in the same loop:

- Fix order of `ctx.error` / `ctx.attempt` updates so error is recorded before incrementing attempt counter
- Rename local `retry` variable to `willRetry` to avoid shadowing the outer function name
- Pass the composed `signal` (instead of raw `cfg.signal`) to `setTimeout` so abort is properly respected during the inter-attempt delay
- Fix oxlint directive from `disable` to `disable-next-line` to suppress only the intended line
