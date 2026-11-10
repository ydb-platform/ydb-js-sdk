---
title: LangChain — YDB Vector Store
description: 'YDB VectorStore for LangChain.js: KNN search, metadata filtering, and approximate nearest-neighbour index.'
---

# LangChain `@ydbjs/langchain`

[YDB](https://ydb.tech) integration for [LangChain.js](https://js.langchain.com) — a `VectorStore` backed by YDB with KNN search support.

## Installation

Requires Node.js `^22.15.0 || >=23.8.0`.

```bash
npm install @ydbjs/langchain @langchain/core
```

## Quick Start

```typescript
import { YDBVectorStore } from '@ydbjs/langchain'
import { OpenAIEmbeddings } from '@langchain/openai'

await using store = new YDBVectorStore(new OpenAIEmbeddings(), {
  connectionString: 'grpc://localhost:2136/local',
})

await store.addDocuments([{ pageContent: 'LangChain supports YDB', metadata: { source: 'docs' } }])

let results = await store.similaritySearch('YDB vector search', 4)
console.log(results)
```

`await using` calls `store[Symbol.asyncDispose]()` automatically on scope exit — no need to call `store.close()` explicitly.

## Driver Lifecycle

### Store-managed Driver (connection string)

With a connection string, the store creates both a `Driver` and a `QueryClient`. Use `await using` or call `await store.close()` to drain the session pool and close the driver.

```typescript
let store = new YDBVectorStore(embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})

// ...

await store.close()
```

### Caller-managed Driver

With an existing `Driver`, the store creates its own query client. Close the store to drain its session pool, then close the driver when all its users have finished.

```typescript
import { Driver } from '@ydbjs/core'

let driver = new Driver('grpc://localhost:2136/local')

await driver.ready()

let store = new YDBVectorStore(embeddings, { driver })

// ...

await store.close()
driver.close()
```

### Sharing a QueryClient

Pass `queryClient` to use the same session pool for vector searches and other application queries. The application owns the shared client and its driver. Close all stores first, then the client, then the driver. With `await using`, declaring them in the order below handles cleanup on scope exit.

```typescript
import { Driver } from '@ydbjs/core'
import { QueryClient } from '@ydbjs/query'

using driver = new Driver('grpc://localhost:2136/local')
await using queryClient = new QueryClient(driver)
await using store = new YDBVectorStore(embeddings, { queryClient })

await store.similaritySearch('YDB vector search', 4)
```

`close()` rejects new operations and waits for active store operations, including document ingestion. It leaves a borrowed `QueryClient` and `Driver` open.

## Static Helpers

```typescript
// Create store and insert documents in one call
let store = await YDBVectorStore.fromDocuments(docs, embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})

// Connect to an existing table without running CREATE TABLE
let store = YDBVectorStore.fromExistingTable(embeddings, {
  driver,
  table: 'my_vectors',
})
```

## Inserting Documents

```typescript
import { Document } from '@langchain/core/documents'

let ids = await store.addDocuments([
  new Document({ pageContent: 'first doc', metadata: { source: 'wiki' } }),
  new Document({ pageContent: 'second doc', metadata: { source: 'docs' }, id: 'my-id' }),
])
// ids[0] → auto-generated UUID
// ids[1] → 'my-id'
```

`addDocuments(documents, { ids })` and `addVectors(vectors, documents, { ids })` accept explicit IDs. `options.ids` takes precedence over `Document.id`. If neither is supplied, the store generates a UUID. The `ids` array must contain one non-empty string per document. IDs are validated before embedding or schema initialization.

```typescript
await store.addDocuments(docs, { ids: ['source-a', 'source-b'] })
await store.addVectors(vectors, docs, { ids: ['source-a', 'source-b'] })
```

Inserting the same ID replaces the document (`UPSERT`). This also applies to IDs supplied by LangChain `index()` with a `RecordManager`.

`batchSize` limits both embedding requests and YDB write batches; the default is 32 documents. Batches run sequentially and commit separately. If a later batch fails, earlier writes remain. Use stable IDs when retrying a failed call: generated UUIDs stay fixed across internal write retries, but a new call generates new UUIDs.

Embeddings must be non-empty, contain finite Float32 values, and have a consistent dimension within an ingestion call. With an index, ingestion and query vectors must match `indexVectorDimension`. Without an index, the store does not infer the dimension of existing rows; use a table with compatible embeddings when changing models.

## Similarity Search

```typescript
// Returns Document[]
let docs = await store.similaritySearch('query text', 4)

// Returns [Document, score][]
let scored = await store.similaritySearchWithScore('query text', 4)

// Search using a pre-computed embedding vector
let vectorResults = await store.similaritySearchVectorWithScore(queryVector, 4)
```

With `k: 0`, search returns an empty array without embedding or accessing the table. A null or invalid score returned by YDB causes an error rather than being converted to zero.

## Cancellation and Timeouts

Pass `signal` to control cancellation for each operation. Use `AbortSignal.timeout(milliseconds)` for a time limit, or combine it with an application signal using `AbortSignal.any(...)`. Retrievers propagate the signal supplied to `invoke`, including when used inside a `RunnableSequence`.

```typescript
await store.addDocuments(docs, {
  ids,
  signal: AbortSignal.timeout(30_000),
})
let retriever = store.asRetriever({
  k: 4,
  filter: { source: 'docs' },
})
let results = await retriever.invoke('query', {
  signal: AbortSignal.any([externalSignal, AbortSignal.timeout(5_000)]),
})
```

Search methods retain the standard LangChain signatures: `similaritySearch(query, k?, filter?, callbacks?)`, `similaritySearchWithScore(query, k?, filter?, callbacks?)`, and `similaritySearchVectorWithScore(vector, k, filter?)`. For cancellable text search, pass `signal` through the retriever's `invoke` configuration. `addDocuments`, `addVectors`, and `delete` accept `signal` in their existing options; `drop` and `createVectorIndex` accept an optional `{ signal }` argument.

The signal covers the complete call: embedding, schema initialization, all batches, and query retries. The time limit starts when the signal is created; reusing the signal shares the same deadline. A cancelled operation starts no further writes. LangChain's `EmbeddingsInterface` does not accept a cancellation signal, so an already dispatched embedding request may continue running. The store stops waiting for it, and `close()` does not wait for that request after the operation is cancelled. Cancelling a YDB write does not establish whether it committed; keep document IDs stable when retrying.

Store argument and state errors use the `YDBVectorStoreError` classes. YDB, embedding-provider, and vector-value errors retain their original types.

## Metadata Filtering

Each key-value pair becomes a `JSON_VALUE` predicate; multiple pairs are combined with `AND`.

```typescript
let results = await store.similaritySearch('query', 4, {
  source: 'docs',
  lang: 'en',
})
```

Filter values must be strings. Keys are relative JSON paths: `tenant.id` selects the nested `id` field of `tenant`, while `'"tenant.id"'` selects a literal field named `tenant.id`.

```typescript
await store.similaritySearch('query', 4, { 'tenant.id': 'nested-value' })
await store.similaritySearch('query', 4, { '"tenant.id"': 'literal-value' })
```

> **Note:** metadata filtering is incompatible with `indexEnabled: true`.

## Search Strategies

| Strategy                     | Sort | Best match    |
| ---------------------------- | ---- | ------------- |
| `CosineSimilarity` (default) | DESC | highest score |
| `InnerProductSimilarity`     | DESC | highest score |
| `CosineDistance`             | ASC  | lowest score  |
| `EuclideanDistance`          | ASC  | lowest score  |
| `ManhattanDistance`          | ASC  | lowest score  |

```typescript
import { YDBVectorStore, YDBSearchStrategy } from '@ydbjs/langchain'

let store = new YDBVectorStore(embeddings, {
  driver,
  strategy: YDBSearchStrategy.EuclideanDistance,
})
```

## Approximate Nearest-Neighbour Index

Build a `vector_kmeans_tree` index for sub-linear search on large tables.

```typescript
let store = new YDBVectorStore(embeddings, {
  driver,
  indexEnabled: true,
  indexVectorDimension: 1536, // Embedding model dimension
})

await store.addDocuments(docs)
await store.createVectorIndex() // build once after initial load
```

Tune the index with optional parameters:

| Config option            | Default                    | Description                                     |
| ------------------------ | -------------------------- | ----------------------------------------------- |
| `indexName`              | `"langchain_vector_index"` | Name of the YDB index                           |
| `indexConfigLevels`      | `2`                        | Tree depth (Recommended 1–3)                    |
| `indexConfigClusters`    | `128`                      | k-means clusters per level (Recommended 64–512) |
| `indexTreeSearchTopSize` | `1`                        | Leaf clusters visited at query time             |

## Deleting Documents

```typescript
// Delete specific documents
await store.delete({ ids: ['id1', 'id2'] })

// Truncate the entire table
await store.delete({ deleteAll: true })

// Drop the table entirely (recreated on next write)
await store.drop()
```

`deleteAll` must be a boolean; clearing the entire table requires `deleteAll: true`. Invalid IDs are rejected before schema initialization. An empty `ids` array without `deleteAll: true` issues no queries.

## Column Name Overrides

Use `columnMap` when connecting to a table with a custom schema.

```typescript
let store = new YDBVectorStore(embeddings, {
  driver,
  table: 'my_vectors',
  columnMap: {
    id: 'doc_id',
    document: 'doc_text',
    embedding: 'doc_vec',
    metadata: 'doc_meta',
  },
})
```

## Examples

The repository contains a runnable example:

- `examples/langchain` — compact TypeScript CLI example showing insert, search, metadata filter, delete, and search strategies.

```bash
cd examples/langchain
npm install
OPENAI_API_KEY=sk-... npm start
```
