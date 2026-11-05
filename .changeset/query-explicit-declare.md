---
'@ydbjs/query': major
'@ydbjs/value': patch
---

Stop generating `DECLARE` statements for tagged SQL. Write explicit declarations for servers or parameter types that require them. Named bindings with `.parameter()` and `.param()` now infer YDB types from native JavaScript values. Pass an SDK Value to select an exact type, or `undefined` to clear a binding. Malformed explicit Values throw when bound. QueryClient.driver exposes its underlying Driver for adapters sharing the client.
