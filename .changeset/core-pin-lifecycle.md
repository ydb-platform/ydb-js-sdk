---
'@ydbjs/core': patch
---

Wait for explicit endpoint pins to reach the routing snapshot before issuing RPCs. Keep shared pins until their last client is disposed, make disposal idempotent, and release the original node even if the caller mutates the target object. Cancelled RPCs leave the client's pin available for subsequent calls.
