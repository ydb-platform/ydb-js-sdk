---
'@ydbjs/langchain': minor
---

Honor explicit document IDs used by LangChain indexing, validate destructive delete options and vector dimensions, and reject invalid search scores. Bound embedding memory by processing and committing one batch at a time, and use the shared Float32 vector value encoding. Accept typed-array views for precomputed vectors and require Node.js 22.15 or a supported newer release.
