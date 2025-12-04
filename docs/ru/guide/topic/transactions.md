---
title: Topic — транзакции
---

# Транзакции в Topic

Интеграция чтения/записи сообщений с транзакциями `@ydbjs/query`.

## Пример

```ts
import { query } from '@ydbjs/query'
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

const sql = query(driver)

await sql.transaction(async (tx, signal) => {
  // ВАЖНО: не используйте `using` в транзакции.
  // Reader/Writer управляются хуками транзакции и корректно завершаются автоматически.
  const reader = createTopicTxReader(tx, driver, {
    topic: '/Root/my-topic',
    consumer: 'c1',
  })

  for await (const batch of reader.read({ signal })) {
    // обработка
  }

  const writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/my-topic',
    producer: 'p1',
  })

  writer.write(new TextEncoder().encode('message'))
  // Ничего явно не закрывайте — writer дождётся флаша в onCommit
})
```

Примечание: TopicTxReader регистрирует обновление оффсетов в `tx.onCommit`, TopicTxWriter — `flush` в `tx.onCommit`, и оба освобождаются в `tx.onClose/tx.onRollback`. Поэтому ручное `close()/destroy()` или `using` внутри тела транзакции не нужно и может помешать корректной фиксации.
