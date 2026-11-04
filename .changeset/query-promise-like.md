---
'@ydbjs/query': patch
---

Accept null callbacks in Query.then() to preserve PromiseLike compatibility when tagged query results are widened to unknown[][].
