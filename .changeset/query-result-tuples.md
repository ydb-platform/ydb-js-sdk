---
'@ydbjs/query': major
---

Use a tuple of row types for query results: `sql<[Row]>` and `session.execute<[Row]>()` describe one result set, while `<[Row, CountRow]>` describes two. Reject a single row type or an unbounded array such as `Row[]` as the result generic.

Keep `execute()` results as `{ resultSets, stats, metadata }`, with `rows`, `columns`, and `truncated` in each result set. Tagged queries continue returning arrays of rows. Preserve the result-set tuple when calling `.values()`.
