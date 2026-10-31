---
'@ydbjs/query': patch
---

Preserve the query tracing context while consuming or closing ExecuteQuery RPCs, without changing the consumer's async context.
