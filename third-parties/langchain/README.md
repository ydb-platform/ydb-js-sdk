# @ydbjs/langchain

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=langchain)](https://codecov.io/gh/ydb-platform/ydb-js-sdk)

[YDB](https://ydb.tech) integration for [LangChain.js](https://js.langchain.com) — a `VectorStore` backed by YDB with KNN search support.

## Installation

```bash
npm install @ydbjs/langchain @langchain/core
```

## Usage

### Using a connection string

The store creates and owns the driver. Call `store.close()` when done.

```typescript
import { YDBVectorStore } from '@ydbjs/langchain'
import { OpenAIEmbeddings } from '@langchain/openai'

const store = new YDBVectorStore(new OpenAIEmbeddings(), {
  connectionString: 'grpc://localhost:2136/local',
})

await store.addDocuments([{ pageContent: 'LangChain supports YDB', metadata: { source: 'docs' } }])

const results = await store.similaritySearch('YDB vector search', 4)
console.log(results)

store.close()
```

### Using a pre-built Driver

Pass your own `Driver` instance — its lifecycle is yours to manage.

```typescript
import { Driver } from '@ydbjs/core'
import { YDBVectorStore } from '@ydbjs/langchain'
import { OpenAIEmbeddings } from '@langchain/openai'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const store = new YDBVectorStore(new OpenAIEmbeddings(), { driver })

await store.addDocuments([{ pageContent: 'LangChain supports YDB', metadata: { source: 'docs' } }])

const results = await store.similaritySearch('YDB vector search', 4)
console.log(results)

driver.close()
```

### Static helpers

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

### Metadata filtering

```typescript
// Each key-value pair becomes a JSON_VALUE predicate; multiple pairs use AND.
// Note: incompatible with indexEnabled: true.
const results = await store.similaritySearch('query', 4, {
  source: 'docs',
  lang: 'en',
})
```

### Approximate nearest-neighbour index

```typescript
const store = new YDBVectorStore(embeddings, {
  driver,
  indexEnabled: true,
  indexVectorDimension: 1536, // length of vectors your embeddings model produces
})

await store.addDocuments(docs)
await store.createVectorIndex() // build once after the initial load
```

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

const store = new YDBVectorStore(embeddings, {
  driver,
  strategy: YDBSearchStrategy.EuclideanDistance,
})
```

## License

Apache-2.0
