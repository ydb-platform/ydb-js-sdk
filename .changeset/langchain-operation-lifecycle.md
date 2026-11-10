---
'@ydbjs/langchain': minor
---

Accept a signal on each LangChain operation, covering embedding, schema setup and query batches. Use AbortSignal.timeout() when a time limit is needed. Preserve Runnable cancellation through retrievers and reject work after the underlying QueryClient closes.

Drain this store's active operations before releasing owned resources. Shared table initialization remains active while another caller needs it, and an uncertain destructive initialization is never repeated implicitly.
