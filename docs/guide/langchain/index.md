---
title: LangChain — YDB Vector Store
description: 'YDB VectorStore for LangChain.js: KNN search, metadata filtering, and approximate nearest-neighbour index.'
---

# LangChain `@ydbjs/langchain`

[YDB](https://ydb.tech) integration for [LangChain.js](https://js.langchain.com) — a `VectorStore` backed by YDB with KNN search support.

## Installation

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

const results = await store.similaritySearch('YDB vector search', 4)
console.log(results)
```

`await using` calls `store[Symbol.asyncDispose]()` automatically on scope exit — no need to call `store.close()` explicitly.

## Driver Lifecycle

### Store-managed Driver (connection string)

The store creates and owns the Driver. Use `await using` or call `store.close()` when done.

```typescript
const store = new YDBVectorStore(embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})
// ...
store.close()
```

### Caller-managed Driver

Pass your own `Driver` instance — its lifecycle is yours to manage.

```typescript
import { Driver } from '@ydbjs/core'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const store = new YDBVectorStore(embeddings, { driver })
// ...
driver.close()
```

## Static Helpers

```typescript
// Create store and insert documents in one call
const store = await YDBVectorStore.fromDocuments(docs, embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})

// Connect to an existing table without running CREATE TABLE
const store = YDBVectorStore.fromExistingTable(embeddings, {
  driver,
  table: 'my_vectors',
})
```

## Inserting Documents

```typescript
import { Document } from '@langchain/core/documents'

const ids = await store.addDocuments([
  new Document({ pageContent: 'first doc', metadata: { source: 'wiki' } }),
  new Document({ pageContent: 'second doc', metadata: { source: 'docs' }, id: 'my-id' }),
])
// ids[0] → auto-generated UUID
// ids[1] → 'my-id'
```

- Documents without an `id` receive a random UUID.
- Re-inserting a document with the same `id` **replaces** it (UPSERT semantics).
- Batches larger than 32 documents are split automatically.

## Similarity Search

```typescript
// Returns Document[]
const docs = await store.similaritySearch('query text', 4)

// Returns [Document, score][]
const scored = await store.similaritySearchWithScore('query text', 4)

// Search using a pre-computed embedding vector
const vectorResults = await store.similaritySearchVectorWithScore(queryVector, 4)
```

## Metadata Filtering

Each key-value pair becomes a `JSON_VALUE` predicate; multiple pairs are combined with `AND`.

```typescript
const results = await store.similaritySearch('query', 4, {
  source: 'docs',
  lang: 'en',
})
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

const store = new YDBVectorStore(embeddings, {
  driver,
  strategy: YDBSearchStrategy.EuclideanDistance,
})
```

## Approximate Nearest-Neighbour Index

Build a `vector_kmeans_tree` index for sub-linear search on large tables.

```typescript
const store = new YDBVectorStore(embeddings, {
  driver,
  indexEnabled: true,
  vectorDimension: 1536, // skip auto-detect probe
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

## Column Name Overrides

Use `columnMap` when connecting to a table with a custom schema.

```typescript
const store = new YDBVectorStore(embeddings, {
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
