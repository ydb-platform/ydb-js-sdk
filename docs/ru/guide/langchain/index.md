---
title: LangChain — YDB Vector Store
description: 'YDB VectorStore для LangChain.js: KNN-поиск, фильтрация по метаданным и приближённый поиск ближайших соседей.'
---

# LangChain `@ydbjs/langchain`

Интеграция [YDB](https://ydb.tech) для [LangChain.js](https://js.langchain.com) — `VectorStore` на базе YDB с поддержкой KNN-поиска.

## Установка

Требуется Node.js `^22.15.0 || >=23.8.0`.

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

let results = await store.similaritySearch('YDB векторный поиск', 4)
console.log(results)
```

`await using` автоматически вызывает `store[Symbol.asyncDispose]()` при выходе из области видимости — вызывать `store.close()` явно не нужно.

## Управление жизненным циклом Driver

### Driver, управляемый стором (connection string)

Если передать строку подключения, стор сам создаст `Driver` и `QueryClient`. Используйте `await using` или вызовите `await store.close()`, чтобы дождаться закрытия пула сессий и драйвера.

```typescript
let store = new YDBVectorStore(embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})

// ...

await store.close()
```

### Driver, управляемый вызывающим кодом

Если передать готовый `Driver`, стор создаст собственный клиент запросов. Вызовите `await store.close()`, чтобы закрыть его пул сессий. Драйвер можно закрыть, когда с ним закончат работать все клиенты.

```typescript
import { Driver } from '@ydbjs/core'

let driver = new Driver('grpc://localhost:2136/local')

await driver.ready()

let store = new YDBVectorStore(embeddings, { driver })

// ...

await store.close()
driver.close()
```

### Общий QueryClient

Передайте `queryClient`, чтобы векторный поиск и остальные запросы приложения использовали один пул сессий. Общим клиентом и драйвером управляет приложение. Сначала закройте все сторы, затем клиент и последним драйвер. В примере ниже `await using` задаёт такой порядок при выходе из блока.

```typescript
import { Driver } from '@ydbjs/core'
import { QueryClient } from '@ydbjs/query'

using driver = new Driver('grpc://localhost:2136/local')
await using queryClient = new QueryClient(driver)
await using store = new YDBVectorStore(embeddings, { queryClient })

await store.similaritySearch('векторный поиск в YDB', 4)
```

`close()` запрещает новые операции и ждёт завершения уже начатых операций стора, включая загрузку документов. Переданные извне `QueryClient` и `Driver` остаются открытыми.

## Статические хелперы

```typescript
// Создать стор и вставить документы за один вызов
let store = await YDBVectorStore.fromDocuments(docs, embeddings, {
  connectionString: 'grpc://localhost:2136/local',
})

// Подключиться к существующей таблице без CREATE TABLE
let store = YDBVectorStore.fromExistingTable(embeddings, {
  driver,
  table: 'my_vectors',
})
```

## Вставка документов

```typescript
import { Document } from '@langchain/core/documents'

let ids = await store.addDocuments([
  new Document({ pageContent: 'первый документ', metadata: { source: 'wiki' } }),
  new Document({ pageContent: 'второй документ', metadata: { source: 'docs' }, id: 'my-id' }),
])
// ids[0] → автоматически сгенерированный UUID
// ids[1] → 'my-id'
```

`addDocuments(documents, { ids })` и `addVectors(vectors, documents, { ids })` принимают явные идентификаторы. `options.ids` имеет приоритет над `Document.id`; без обоих значений стор генерирует UUID. Массив `ids` должен содержать по одной непустой строке на документ. Идентификаторы проверяются до обращения к модели эмбеддингов и создания таблицы.

```typescript
await store.addDocuments(docs, { ids: ['source-a', 'source-b'] })
await store.addVectors(vectors, docs, { ids: ['source-a', 'source-b'] })
```

Повторная вставка с тем же ID заменяет документ (`UPSERT`). Это правило применяется и к ID, которые передаёт LangChain `index()` через `RecordManager`.

`batchSize` ограничивает число документов и в запросе к модели эмбеддингов, и в записи в YDB; по умолчанию — 32. Пакеты обрабатываются последовательно и фиксируются отдельно. Если поздний пакет завершится с ошибкой, уже записанные документы останутся в таблице. Для повторного вызова используйте стабильные ID: автоматически сгенерированные UUID сохраняются при внутренних повторах записи, но новый вызов создаёт новые UUID.

Эмбеддинги должны быть непустыми, содержать конечные значения Float32 и иметь одинаковую размерность в пределах одной загрузки. При включённом индексе размерность загрузки и поискового вектора должна совпадать с `indexVectorDimension`. Без индекса стор не определяет размерность существующих данных автоматически; при смене модели используйте таблицу с совместимыми эмбеддингами.

## Поиск по сходству

```typescript
// Возвращает Document[]
let docs = await store.similaritySearch('текст запроса', 4)

// Возвращает [Document, score][]
let scored = await store.similaritySearchWithScore('текст запроса', 4)

// Поиск по готовому вектору эмбеддинга
let vectorResults = await store.similaritySearchVectorWithScore(queryVector, 4)
```

При `k: 0` методы поиска возвращают пустой массив без запроса к модели эмбеддингов и без обращения к таблице. Если YDB возвращает `null` или некорректный score, поиск завершается ошибкой вместо подмены результата нулём.

## Отмена и ограничения времени

В `operationOptions` можно задать общие `signal`, `timeout` в миллисекундах и `retry` из `@ydbjs/query`. Параметры, переданные прямо в метод стора, заменяют общие `timeout` и `retry`. Таймаут или сигнал LangChain Runnable дополнительно ограничивает операцию: таймаут стора продолжает действовать, в том числе внутри `RunnableSequence`. Сигналы из конфигурации, отдельного вызова и retriever объединяются: отмена любого из них останавливает операцию. Стор не задаёт таймаут по умолчанию.

```typescript
let store = new YDBVectorStore(embeddings, {
  queryClient,
  operationOptions: { timeout: 30_000 },
})

await store.addDocuments(docs, { ids, signal })
let results = await store.similaritySearch('query', 4, undefined, undefined, {
  signal,
  timeout: 5_000,
})
let retrieved = await store.asRetriever().invoke('query', { signal, timeout: 5_000 })
```

У `similaritySearch` и `similaritySearchWithScore` четвёртый аргумент сохраняет назначение LangChain callbacks, а параметры операции передаются пятым аргументом. У `similaritySearchVectorWithScore` они передаются четвёртым аргументом. `addDocuments`, `addVectors` и `delete` принимают их вместе с остальными параметрами; `drop` и `createVectorIndex` — единственным необязательным аргументом.

Один таймаут действует на весь вызов: получение эмбеддингов, подготовку таблицы, все пакеты и повторы запросов. Отменённая операция не начинает следующие записи. Интерфейс LangChain `EmbeddingsInterface` не принимает сигнал отмены, поэтому уже отправленный запрос к модели может продолжать работу. Стор прекращает его ожидание; `close()` не ждёт такой запрос после отмены операции. Отмена записи в YDB не доказывает, что запись не была выполнена; при повторе сохраняйте ID документов.

Ошибки проверки аргументов и состояния используют классы `YDBVectorStoreError`. Ошибки YDB, модели эмбеддингов и значений векторов сохраняют свои исходные типы.

## Фильтрация по метаданным

Каждая пара ключ-значение превращается в предикат `JSON_VALUE`; несколько пар объединяются через `AND`. Значения фильтра должны быть строками. Ключ — относительный JSONPath: `tenant.id` выбирает поле `id` внутри объекта `tenant`, а `'"tenant.id"'` — поле с буквальным именем `tenant.id`.

```typescript
let results = await store.similaritySearch('запрос', 4, {
  source: 'docs',
  lang: 'ru',
})

await store.similaritySearch('query', 4, { 'tenant.id': 'nested-value' })
await store.similaritySearch('query', 4, { '"tenant.id"': 'literal-value' })
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

let store = new YDBVectorStore(embeddings, {
  driver,
  strategy: YDBSearchStrategy.EuclideanDistance,
})
```

## Приближённый поиск ближайших соседей (ANN-индекс)

Создайте индекс `vector_kmeans_tree` для сублинейного поиска на больших таблицах.

```typescript
let store = new YDBVectorStore(embeddings, {
  driver,
  indexEnabled: true,
  indexVectorDimension: 1536, // Embedding model dimension
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

`deleteAll` принимает только boolean; очистка всей таблицы требует `deleteAll: true`. Неверные ID отклоняются до подготовки таблицы. Пустой массив `ids` без `deleteAll: true` не выполняет запросов.

## Переопределение имён колонок

Используйте `columnMap` при подключении к таблице с нестандартной схемой.

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

## Примеры

В репозитории есть готовый пример:

- `examples/langchain` — TypeScript CLI-пример со вставкой, поиском, фильтрацией по метаданным, удалением и демонстрацией стратегий поиска.

```bash
cd examples/langchain
npm install
OPENAI_API_KEY=sk-... npm start
```
