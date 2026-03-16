---
'@ydbjs/auth': minor
---

Fix memory leak in background token refresh caused by `AbortSignal.any()`

`AbortSignal.any()` registers event listeners on source signals but never removes them, causing a listener leak each time background token refresh is started. Replace it with `linkSignals` from `@ydbjs/abortable@^6.1.0`, which uses `Symbol.dispose` to clean up listeners when the refresh loop exits.

Additional fixes:

- Pass `signal` from the retry callback into `#client.login()` so the login RPC is properly cancelled on abort instead of running unchecked
- Update `@ydbjs/retry` dependency to `^6.2.0` to pick up the same signal-handling fixes in the retry loop
