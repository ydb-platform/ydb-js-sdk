---
'@ydbjs/drizzle-adapter': patch
---

Preserve selected fields named `__proto__`, `constructor`, and `toString` as own properties when mapping query results. Nested selections no longer traverse inherited objects, and object-row lookup ignores inherited properties while retaining positional fallback for absent fields.
