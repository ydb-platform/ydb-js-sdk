---
'@ydbjs/topic': patch
---

Keep Topic requests and token refreshes attached to the current stream. Ignore obsolete completions, prevent opening streams after cancellation, and continue reader token renewal when unchanged credentials are not acknowledged.
