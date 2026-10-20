---
'@ydbjs/core': patch
---

Cancel active calls and pending token waits when a service client closes, and discard its buffered responses. Preserve sibling clients and the driver-owned shared connections.
