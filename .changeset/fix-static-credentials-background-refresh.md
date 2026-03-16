---
'@ydbjs/auth': patch
---

Fix `StaticCredentialsProvider` background token refresh being immediately cancelled

`#refreshTokenInBackground` previously used `void this.#refreshToken(linkedSignal.signal)` — fire-and-forget, so `using linkedSignal` stayed alive for the duration of the refresh. After the fix for the memory leak the call became `await this.#refreshToken(...)`, which caused `[Symbol.dispose]` to run synchronously at the end of the `async` function frame — before the refresh had a chance to complete — aborting the underlying `AbortController` and cancelling every background refresh immediately.
