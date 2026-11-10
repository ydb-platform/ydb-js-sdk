# @ydbjs/langchain

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=langchain)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/third-parties/langchain/)

[YDB](https://ydb.tech) integration for [LangChain.js](https://js.langchain.com) — a `VectorStore` backed by YDB with KNN search support.

## Installation

Requires Node.js `^22.15.0 || >=23.8.0`.

```bash
npm install @ydbjs/langchain @langchain/core
```

## Usage

### Using a connection string

The store creates its own driver and query client. Call `await store.close()` to drain the session pool and close the driver.

```typescript
import { YDBVectorStore } from '@ydbjs/langchain'
import { OpenAIEmbeddings } from '@langchain/openai'

let store = new YDBVectorStore(new OpenAIEmbeddings(), {
  connectionString: 'grpc://localhost:2136/local',
})

await store.addDocuments([
  {
    pageContent: 'LangChain supports YDB',
    metadata: { source: 'docs' },
  },
])

let results = await store.similaritySearch('YDB vector search', 4)

console.log(results)

await store.close()
```

### Using a pre-built Driver

The store creates its own query client for the supplied driver. Close the store to drain that client’s pool, then close the driver when your application has finished with it.

```typescript
import { Driver } from '@ydbjs/core'
import { YDBVectorStore } from '@ydbjs/langchain'
import { OpenAIEmbeddings } from '@langchain/openai'

let driver = new Driver('grpc://localhost:2136/local')

await driver.ready()

let store = new YDBVectorStore(new OpenAIEmbeddings(), { driver })

await store.addDocuments([
  {
    pageContent: 'LangChain supports YDB',
    metadata: { source: 'docs' },
  },
])

let results = await store.similaritySearch('YDB vector search', 4)

console.log(results)

await store.close()
driver.close()
```

### Sharing a QueryClient

Pass `queryClient` to share an existing session pool across stores and application queries. The caller owns the shared client and its driver.

```typescript
import { Driver } from '@ydbjs/core'
import { QueryClient } from '@ydbjs/query'
import { YDBVectorStore } from '@ydbjs/langchain'
import { OpenAIEmbeddings } from '@langchain/openai'

using driver = new Driver('grpc://localhost:2136/local')
await using queryClient = new QueryClient(driver)
await using store = new YDBVectorStore(new OpenAIEmbeddings(), { queryClient })

let results = await store.similaritySearch('YDB vector search', 4)
```

`close()` rejects new operations and waits for active store operations, including document ingestion. It leaves a borrowed `QueryClient` and `Driver` open.

### Static helpers

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

### Inserting documents

`addDocuments(documents, { ids })` and `addVectors(vectors, documents, { ids })` accept explicit IDs. `options.ids` takes precedence over `Document.id`. If neither is supplied, the store generates a UUID. The `ids` array must contain one non-empty string per document. IDs are validated before embedding or schema initialization.

```typescript
await store.addDocuments(docs, { ids: ['source-a', 'source-b'] })
await store.addVectors(vectors, docs, { ids: ['source-a', 'source-b'] })
```

Inserting the same ID replaces the document (`UPSERT`). This also applies to IDs supplied by LangChain `index()` with a `RecordManager`.

`batchSize` limits both embedding requests and YDB write batches; the default is 32 documents. Batches run sequentially and commit separately. If a later batch fails, earlier writes remain. Use stable IDs when retrying a failed call: generated UUIDs stay fixed across internal write retries, but a new call generates new UUIDs.

Embeddings must be non-empty, contain finite Float32 values, and have a consistent dimension within an ingestion call. With an index, ingestion and query vectors must match `indexVectorDimension`. Without an index, the store does not infer the dimension of existing rows; use a table with compatible embeddings when changing models.

### Metadata filtering

```typescript
// Each key-value pair becomes a JSON_VALUE predicate; multiple pairs use AND.
// Note: incompatible with indexEnabled: true.
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

### Approximate nearest-neighbour index

```typescript
let store = new YDBVectorStore(embeddings, {
  driver,
  indexEnabled: true,
  indexVectorDimension: 1536, // length of vectors your embeddings model produces
})

await store.addDocuments(docs)
await store.createVectorIndex() // build once after the initial load
```

### Cancellation and timeouts

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

## Search strategies

| Strategy                     | Sort order | Best match    |
| ---------------------------- | ---------- | ------------- |
| `CosineSimilarity` (default) | DESC       | highest score |
| `InnerProductSimilarity`     | DESC       | highest score |
| `CosineDistance`             | ASC        | lowest score  |
| `EuclideanDistance`          | ASC        | lowest score  |
| `ManhattanDistance`          | ASC        | lowest score  |

```typescript
import { YDBVectorStore, YDBSearchStrategy } from '@ydbjs/langchain'

let store = new YDBVectorStore(embeddings, {
  driver,
  strategy: YDBSearchStrategy.EuclideanDistance,
})
```

## License

Apache-2.0
