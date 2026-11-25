---
title: Topic — примеры
---

# Примеры Topic

## Базовый reader/commit

```ts
import { topic } from '@ydbjs/topic'

let t = topic(driver)
await using reader = t.createReader({ topic: '/Root/my-topic', consumer: 'c1' })

for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000 })) {
  if (!batch.length) {
    continue
  }

  // обработка
  await reader.commit(batch)
}
```

## Writer

```ts
await using writer = t.createWriter({ topic: '/Root/my-topic', producer: 'p1' })
writer.write(new TextEncoder().encode('hello'))
await writer.flush()
```

## Кастомные кодеки

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
  consumer: 'c1',
  codecMap: new Map([[Codec.GZIP, MyGzip]]),
})
```

## Транзакционный сценарий

```ts
import { query } from '@ydbjs/query'
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

await using sql = query(driver)
await sql.begin(async (tx, signal) => {
  let reader = createTopicTxReader(tx, driver, {
    topic: '/Root/my-topic',
    consumer: 'c1',
  })

  for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000, signal })) {
    // обработка внутри транзакции
    break
  }

  let writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/my-topic',
    producer: 'p1',
  })

  writer.write(new TextEncoder().encode('in-tx'))
})
```
