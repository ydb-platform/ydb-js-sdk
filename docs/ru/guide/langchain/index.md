---
title: LangChain — YDB Vector Store
description: 'YDB VectorStore для LangChain.js: KNN-поиск, фильтрация по метаданным и приближённый поиск ближайших соседей.'
---

# LangChain `@ydbjs/langchain`

Интеграция [YDB](https://ydb.tech) для [LangChain.js](https://js.langchain.com) — `VectorStore` на базе YDB с поддержкой KNN-поиска.

## Установка

```bash
npm install @ydbjs/langchain @langchain/core
```

## Быстрый старт

```typescript
import { YDBVectorStore } from '@ydbjs/langchain'
import { OpenAIEmbeddings } from '@langchain/openai'

await using store = new YDBVectorStore(new OpenAIEmbeddings(), {
  connectionString: 'grpc://localhost:2136/local',
})

await store.addDocuments([
  { pageContent: 'LangChain поддерживает YDB', metadata: { source: 'docs' } },
])

const results = await store.similaritySearch('YDB векторный поиск', 4)
console.log(results)
```

`await using` автоматически вызывает `store[Symbol.asyncDispose]()` при выходе из области видимости — вызывать `store.close()` явно не нужно.

## Управление жизненным циклом Driver

### Driver, управляемый стором (connection string)

Стор создаёт Driver и владеет им. Используйте `await using` или вызывайте `store.close()` по завершении.

```typescript
const store = new YDBVectorStore(embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})
// ...
store.close()
```

### Driver, управляемый вызывающим кодом

Передайте готовый экземпляр `Driver` — его жизненный цикл остаётся за вами.

```typescript
import { Driver } from '@ydbjs/core'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const store = new YDBVectorStore(embeddings, { driver })
// ...
driver.close()
```

## Статические хелперы

```typescript
// Создать стор и вставить документы за один вызов
const store = await YDBVectorStore.fromDocuments(docs, embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})

// Подключиться к существующей таблице без CREATE TABLE
const store = YDBVectorStore.fromExistingTable(embeddings, {
  driver,
  table: 'my_vectors',
})
```

## Вставка документов

```typescript
import { Document } from '@langchain/core/documents'

const ids = await store.addDocuments([
  new Document({ pageContent: 'первый документ', metadata: { source: 'wiki' } }),
  new Document({ pageContent: 'второй документ', metadata: { source: 'docs' }, id: 'my-id' }),
])
// ids[0] → автоматически сгенерированный UUID
// ids[1] → 'my-id'
```

- Документы без явного `id` получают случайный UUID.
- Повторная вставка документа с тем же `id` **заменяет** его (семантика UPSERT).
- Батчи больше 32 документов разбиваются автоматически.

## Поиск по сходству

```typescript
// Возвращает Document[]
const docs = await store.similaritySearch('текст запроса', 4)

// Возвращает [Document, score][]
const scored = await store.similaritySearchWithScore('текст запроса', 4)

// Поиск по готовому вектору эмбеддинга
const vectorResults = await store.similaritySearchVectorWithScore(queryVector, 4)
```

## Фильтрация по метаданным

Каждая пара ключ-значение превращается в предикат `JSON_VALUE`; несколько пар объединяются через `AND`.

```typescript
const results = await store.similaritySearch('запрос', 4, {
  source: 'docs',
  lang: 'ru',
})
```

> **Примечание:** фильтрация по метаданным несовместима с `indexEnabled: true`.

## Стратегии поиска

| Стратегия                         | Сортировка | Лучшее совпадение  |
| --------------------------------- | ---------- | ------------------ |
| `CosineSimilarity` (по умолчанию) | DESC       | максимальный score |
| `InnerProductSimilarity`          | DESC       | максимальный score |
| `CosineDistance`                  | ASC        | минимальный score  |
| `EuclideanDistance`               | ASC        | минимальный score  |
| `ManhattanDistance`               | ASC        | минимальный score  |

```typescript
import { YDBVectorStore, YDBSearchStrategy } from '@ydbjs/langchain'

const store = new YDBVectorStore(embeddings, {
  driver,
  strategy: YDBSearchStrategy.EuclideanDistance,
})
```

## Приближённый поиск ближайших соседей (ANN-индекс)

Создайте индекс `vector_kmeans_tree` для сублинейного поиска на больших таблицах.

```typescript
const store = new YDBVectorStore(embeddings, {
  driver,
  indexEnabled: true,
  vectorDimension: 1536, // пропустить авто-определение размерности
})

await store.addDocuments(docs)
await store.createVectorIndex() // построить один раз после начальной загрузки
```

Параметры настройки индекса:

| Параметр                 | По умолчанию               | Описание                                            |
| ------------------------ | -------------------------- | --------------------------------------------------- |
| `indexName`              | `"langchain_vector_index"` | Имя индекса в YDB                                   |
| `indexConfigLevels`      | `2`                        | Глубина дерева (Рекомендуется 1–3)                  |
| `indexConfigClusters`    | `128`                      | Кластеров k-means на уровень (Рекомендуется 64–512) |
| `indexTreeSearchTopSize` | `1`                        | Листовых кластеров при запросе                      |

## Удаление документов

```typescript
// Удалить конкретные документы
await store.delete({ ids: ['id1', 'id2'] })

// Очистить всю таблицу
await store.delete({ deleteAll: true })

// Удалить таблицу целиком (будет пересоздана при следующей записи)
await store.drop()
```

## Переопределение имён колонок

Используйте `columnMap` при подключении к таблице с нестандартной схемой.

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

## Примеры

В репозитории есть готовый пример:

- `examples/langchain` — TypeScript CLI-пример со вставкой, поиском, фильтрацией по метаданным, удалением и демонстрацией стратегий поиска.

```bash
cd examples/langchain
npm install
OPENAI_API_KEY=sk-... npm start
```
