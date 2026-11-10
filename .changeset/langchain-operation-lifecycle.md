---
'@ydbjs/langchain': minor
---

Add operation signals, timeouts and retry options across LangChain embedding, schema setup and query batches. Preserve Runnable cancellation through retrievers and reject work after the underlying QueryClient closes.

Drain this store's active operations before releasing owned resources. Shared table initialization remains active while another caller needs it, and an uncertain destructive initialization is never repeated implicitly.
