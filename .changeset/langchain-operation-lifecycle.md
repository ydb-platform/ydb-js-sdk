---
'@ydbjs/langchain': minor
---

Propagate caller cancellation through LangChain retrievers, writes and schema operations, covering embedding and query batches. Search methods retain the native LangChain signatures; pass a signal through retriever.invoke() for cancellable text search. Use AbortSignal.timeout() when a time limit is needed and reject work after the underlying QueryClient closes.

Drain this store's active operations before releasing owned resources. Shared table initialization remains active while another caller needs it, and an uncertain destructive initialization is never repeated implicitly.
