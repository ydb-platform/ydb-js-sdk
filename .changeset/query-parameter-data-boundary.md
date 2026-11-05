---
'@ydbjs/query': patch
'@ydbjs/drizzle-adapter': patch
'@ydbjs/langchain': patch
---

Infer tagged parameters through fromJs so JSON type-like fields cannot supply SQL declaration syntax. Reject malformed explicit Value bindings before generating declarations. Escape backslashes as well as backticks in quoted identifiers.

Use default YQL string escaping in Drizzle inline values and DDL builders, and in LangChain filter paths. Preserve backslashes before escaping quotes so data cannot terminate generated SQL literals.
