---
'@ydbjs/query': minor
---

Add composable query fragments: `fragment` (and `sql.fragment`) builds a non-executable piece of YQL with its own bound parameters, and `join` (and `sql.join`) combines fragments with a separator. Fragments nest into other `sql`/`fragment` templates, with parameters renumbered automatically — enabling dynamic `WHERE`/`IN`/KNN clauses without hand-building parameter names.
