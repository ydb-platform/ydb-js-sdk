---
'@ydbjs/langchain': minor
---

Pass `queryClient` to `YDBVectorStore` to share an existing session pool. The store borrows the supplied client and driver. With a supplied driver it owns the pool, and with a connection string it owns both resources.

Run vector queries through QueryClient with named parameters. Searches can retry after a lost response without repeating schema changes or embedding requests. An indexed search with a metadata filter fails before lazy table initialization, including when `dropExistingTable` is set.
