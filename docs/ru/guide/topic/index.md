---
title: Topic — обзор
---

# Topic (packages/topic)

Клиенты для YDB Topics: потоковое чтение/запись, оффсеты, кодеки, транзакции.

## Быстрый старт

```ts
import { Driver } from '@ydbjs/core'
import { topic } from '@ydbjs/topic'

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

let t = topic(driver)
await using reader = t.createReader({ topic: '/Root/my-topic', consumer: 'c1' })
for await (let batch of reader.read()) {
  await reader.commit(batch)
}
```

## Writer

```ts
await using writer = t.createWriter({ topic: '/Root/my-topic', producer: 'p1' })
writer.write(new TextEncoder().encode('Hello'))
await writer.flush()
```

## Примеры {#examples}

### Reader с батчами и таймаутами {#examples-reader-batching}

```ts
await using reader = t.createReader({
  topic: '/Root/my-topic',
  consumer: 'svc-a',
})

for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000 })) {
  if (!batch.length) {
    continue
  }

  // обработка батча
  await reader.commit(batch)
}
```

### Кастомные кодеки (gzip) {#examples-codecs}

```ts
import { Codec } from '@ydbjs/api/topic'
import * as zlib from 'node:zlib'

let MyGzip = {
  codec: Codec.GZIP,
  compress(payload: Uint8Array) {
    return zlib.gzipSync(payload)
  },
  decompress(payload: Uint8Array) {
    return zlib.gunzipSync(payload)
  },
}

await using reader = t.createReader({
  topic: '/Root/custom',
  consumer: 'svc-a',
  codecMap: new Map([[Codec.GZIP, MyGzip]]),
})
```

### Транзакционный reader/writer {#examples-tx}

```ts
import { query } from '@ydbjs/query'
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

await using sql = query(driver)
await sql.begin(async (tx, signal) => {
  let reader = createTopicTxReader(tx, driver, {
    topic: '/Root/my-topic',
    consumer: 'svc-a',
  })

  for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000, signal })) {
    // внутри транзакции
    break
  }

  let writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/my-topic',
    producer: 'p1',
  })

  writer.write(new TextEncoder().encode('in-tx'))
})
```

### Подтверждения writer и seqNo {#examples-acks}

```ts
await using writer = t.createWriter({
  topic: '/Root/my-topic',
  producer: 'p1',
  onAck(seqNo, status) {
    console.log('ack', seqNo, status)
  },
})
writer.write(new TextEncoder().encode('hello'))
await writer.flush()
```

### Лимиты размера и inflight {#examples-limits}

```ts
// Внутренне одно сообщение > 48MiB будет отклонено клиентом Topic
// Разбивайте нагрузку или используйте сжатие через кодеки
```

### Несколько источников и фильтры партиций {#examples-sources}

```ts
await using reader = t.createReader({
  topic: [{ path: '/Root/topic-a', partitionIds: [0n, 1n] }, { path: '/Root/topic-b' }],
  consumer: 'svc-a',
})

for await (let batch of reader.read({ batchWindowMs: 500 })) {
  // обработка сообщений с обеих тем, с фильтрацией партиций
}
```

### Хуки сессий партиций {#examples-hooks}

```ts
await using reader = t.createReader({
  topic: '/Root/metrics',
  consumer: 'svc-a',
  onPartitionSessionStart: async (session, committed, { start, end }) => {
    // сдвигаем readOffset, чтобы продолжить с последнего закоммиченного
    return { readOffset: committed }
  },
  onPartitionSessionStop: async (session, committed) => {
    console.log('partition closed', session.partitionSessionId, 'committed', committed)
  },
  onCommittedOffset: (session, committed) => {
    // Observes acknowledgments; commit() still needs error handling.
    console.log('committed', session.partitionSessionId, committed)
  },
})
```

### Временные селекторы: readFrom и maxLag {#examples-time-selectors}

```ts
await using reader = t.createReader({
  topic: {
    path: '/Root/events',
    readFrom: new Date(Date.now() - 60_000), // последние 1 минута
    maxLag: '30s', // или число миллисекунд
  },
  consumer: 'svc-a',
})
for await (let batch of reader.read({ batchWindowMs: 500 })) {
  // обрабатываем только свежие события
}
```

### Корректное завершение {#examples-shutdown}

```ts
await reader.close() // дождётся pending-коммитов с защитным таймаутом
await writer.close() // выполнит flush и дождётся подтверждений
```
