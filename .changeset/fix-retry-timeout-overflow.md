---
'@ydbjs/retry': patch
---

Fix TimeoutOverflowWarning caused by unbounded exponential backoff. Replace `exponential(ms)` with `backoff(base, max)` which caps the delay via `Math.min(2^attempt * base, max)`, preventing `Infinity` from being passed to `setTimeout`.
