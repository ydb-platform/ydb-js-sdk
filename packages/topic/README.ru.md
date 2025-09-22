# @ydbjs/topic

Читать на английском: [README.md](README.md)

Высокоуровневые, типобезопасные клиенты для YDB Topics (стриминговые очереди сообщений) на JavaScript/TypeScript. Поддерживаются эффективное потоковое чтение/запись, управление сессиями партиций, коммиты оффсетов, сжатие и транзакции.

## Возможности

- Потоковый reader и writer с async‑итерацией
- Хуки жизненного цикла сессий партиций и коммит оффсетов
- Подключаемые кодеки сжатия (RAW, GZIP, ZSTD; можно свои)
- Чтение/запись с привязкой к транзакциям
- Полные типы TypeScript

## Установка

```sh
npm install @ydbjs/topic
```

Требуется Node.js >= 20.19.

## Быстрый старт

Два варианта использования:

- Через верхнеуровневый клиент `topic(driver)`
- Через фабрики (`@ydbjs/topic/reader`, `@ydbjs/topic/writer`)

### Через верхнеуровневый клиент

```ts
import { Driver } from '@ydbjs/core'
import { topic } from '@ydbjs/topic'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

const t = topic(driver)

// Reader
await using reader = t.createReader({ topic: '/Root/my-topic', consumer: 'my-consumer' })
for await (const batch of reader.read()) {
  for (const msg of batch) console.log(new TextDecoder().decode(msg.payload))
  await reader.commit(batch)
}

// Writer
await using writer = t.createWriter({ topic: '/Root/my-topic', producer: 'my-producer' })
writer.write(new TextEncoder().encode('Hello, YDB!'))
await writer.flush()
```

### Через фабрики

```ts
import { Driver } from '@ydbjs/core'
import { createTopicReader, createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicWriter, createTopicTxWriter } from '@ydbjs/topic/writer'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

await using reader = createTopicReader(driver, { topic: '/Root/my-topic', consumer: 'my-consumer' })
await using writer = createTopicWriter(driver, { topic: '/Root/my-topic', producer: 'my-producer' })
```

## Reader

### Опции

- `topic`: `string | TopicReaderSource | TopicReaderSource[]` — путь или источники с фильтрами
- `consumer`: `string` — имя консюмера
- `codecMap?`: `Map<Codec | number, CompressionCodec>` — свои кодеки для распаковки
- `maxBufferBytes?`: `bigint` — лимит внутреннего буфера (по умолчанию ~4 МБ)
- `updateTokenIntervalMs?`: `number` — период обновления токена (по умолчанию 60000)
- `onPartitionSessionStart?` — настройка оффсетов при старте сессии
- `onPartitionSessionStop?` — хук на остановку сессии
- `onCommittedOffset?` — уведомление об ack коммита оффсетов

TopicReaderSource поддерживает фильтры партиций и временные селекторы:

```ts
const source = {
  path: '/Root/my-topic',
  partitionIds: [0n, 1n],
  maxLag: '5m',
  readFrom: new Date(Date.now() - 60_000),
}
```

### Чтение и коммиты

```ts
const t = topic(driver)
await using reader = t.createReader({ topic: source, consumer: 'svc-a' })

for await (const batch of reader.read({ limit: 100, waitMs: 1000 })) {
  if (!batch.length) continue

  for (const m of batch) doSomething(m)

  // Вариант A: простой — await commit
  await reader.commit(batch)

  // Вариант B: быстрый — fire‑and‑forget
  // void reader.commit(batch)
}
```

Перформанс‑заметка: `await commit()` в горячем пути снижает пропускную способность. Для высоких нагрузок используйте fire‑and‑forget плюс `onCommittedOffset`.

## Writer

### Опции

- `topic`: `string`
- `tx?`: `TX` — транзакция для записи
- `producer?`: `string` — id продюсера (по умолчанию генерируется)
- `codec?`: `CompressionCodec` — сжатие (RAW/GZIP/ZSTD или своё)
- `maxBufferBytes?`: `bigint` — лимит буфера (по умолчанию 256 МБ)
- `maxInflightCount?`: `number` — максимум сообщений «в полёте» (по умолчанию 1000)
- `flushIntervalMs?`: `number` — периодический флаш (по умолчанию 10 мс)
- `updateTokenIntervalMs?`: `number` — период обновления токена (по умолчанию 60000)
- `retryConfig?(signal)` — настройка ретраев соединения
- `onAck?(seqNo, status)` — колбэк подтверждений

### Запись

```ts
const t = topic(driver)
await using writer = t.createWriter({ topic: '/Root/my-topic', producer: 'json-producer' })

const payload = new TextEncoder().encode(JSON.stringify({ foo: 'bar', ts: Date.now() }))
const seqNo = writer.write(payload)
await writer.flush()
```

`write()` принимает только `Uint8Array` — строки/объекты кодируйте самостоятельно.

## Транзакции

Запускайте чтение/запись внутри обработчика транзакций `@ydbjs/query` и передавайте `tx`, который он выдаёт.

- Reader: `createTopicTxReader(driver, { topic, consumer, tx })` или `t.createTxReader({ ..., tx })`. Offsets будут учтены через updateOffsetsInTransaction на коммите.
- Writer: `createTopicTxWriter(tx, driver, { topic, ... })` или `t.createTxWriter(tx, { ... })`. Writer дождётся флаша перед коммитом.

```ts
import { query } from '@ydbjs/query'
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

const qc = query(driver)

await qc.transaction(async (tx, signal) => {
  await using reader = createTopicTxReader(driver, { topic: '/Root/my-topic', consumer: 'svc-a', tx })
  for await (const batch of reader.read({ signal })) {
    // обработка...
  }

  await using writer = createTopicTxWriter(tx, driver, { topic: '/Root/my-topic', producer: 'p1' })
  writer.write(new TextEncoder().encode('message'))
})
```

Примечание: объект `tx` предоставляет слой Query; интеграция с Topic выполняется автоматически внутри клиентов.

## Свои кодеки

Reader: через `codecMap`, Writer: передайте объект `CompressionCodec`.

```ts
import { Codec } from '@ydbjs/api/topic'
import * as zlib from 'node:zlib'

const MyGzip = {
  codec: Codec.GZIP,
  compress: (p: Uint8Array) => zlib.gzipSync(p),
  decompress: (p: Uint8Array) => zlib.gunzipSync(p),
}

await using reader = createTopicReader(driver, {
  topic: '/Root/custom',
  consumer: 'c1',
  codecMap: new Map([[Codec.GZIP, MyGzip]]),
})

await using writer = createTopicWriter(driver, {
  topic: '/Root/custom',
  producer: 'p1',
  codec: MyGzip,
})
```

## Экспортируемые модули

- `@ydbjs/topic`: `topic(driver)` и типы
- `@ydbjs/topic/reader`: `createTopicReader`, `createTopicTxReader` и типы
- `@ydbjs/topic/writer`: `createTopicWriter`, `createTopicTxWriter` и типы
- `@ydbjs/topic/writer2`: экспериментальный state‑machine writer (API может измениться)

## Лицензия

Apache-2.0
