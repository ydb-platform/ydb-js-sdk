---
'@ydbjs/abortable': patch
'@ydbjs/api': patch
'@ydbjs/auth': patch
'@ydbjs/coordination': patch
'@ydbjs/core': patch
'@ydbjs/debug': patch
'@ydbjs/error': patch
'@ydbjs/fsm': patch
'@ydbjs/grpc': patch
'@ydbjs/query': patch
'@ydbjs/retry': patch
'@ydbjs/telemetry': patch
'@ydbjs/topic': patch
'@ydbjs/value': patch
---

Use the internal ydbjs-source condition for workspace tests. Standard development imports resolve to the published JavaScript entry points instead of missing TypeScript sources.
