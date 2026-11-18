---
title: Query — транзакции
---

# Транзакции в Query

В `@ydbjs/query` есть два удобных метода: `begin` и `transaction`.

- `begin(options?, fn)` — создаёт транзакцию, выполняет `fn(tx, signal)` и коммитит при успехе. В случае ошибки пытается откатить транзакцию.
- `transaction(options?, fn)` — алиас `begin`.

Опции:

- `isolation?: 'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite'` — уровень изоляции транзакции (по умолчанию `serializableReadWrite`).
- `idempotent?: boolean` — включает повторные попытки при условно‑повторяемых ошибках. Важно обеспечивать идемпотентность бизнес‑операции.

В настройки также входят `signal`, `timeout`, `retry: { budget, strategy }` и `onRetry`.
Второй аргумент callback — сигнал текущей попытки; передавайте его своему асинхронному коду.

Callback может выполниться повторно целиком, в том числе при `idempotent: false` для однозначно прерванных операций.
Создавайте состояние попытки внутри callback и учитывайте повтор внешних эффектов.
`onCommit()` тегового API выполняется до RPC commit; в `QueryClient.retryTransaction()` этот hook называется `beforeCommit()`.
Отмена или потерянный ответ не доказывают rollback.
Ошибка cleanup после подтверждённого коммита возвращается как `TransactionCompletionError` с `committed: true` и исходной ошибкой в `cause`; SDK её не повторяет.

## Базовое использование

```ts
let result = await sql.begin(async (tx) => {
  await tx`UPDATE users SET active = false WHERE id = ${42}`
  return await tx`SELECT * FROM users WHERE active = false`
})
```

## Опции изоляции и идемпотентности

```ts
await sql.begin(
  {
    isolation: 'snapshotReadOnly',
    idempotent: true,
  },
  async (tx) => {
    return await tx`SELECT COUNT(*) FROM users`
  }
)
```

## Интеграция с Topic (без using)

При работе в рамках `sql.transaction(...)` используйте tx‑aware клиенты Topic без `using`/явного закрытия:

```ts
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

await sql.transaction({ signal: AbortSignal.timeout(10_000) }, async (tx, signal) => {
  let reader = createTopicTxReader(tx, driver, {
    topic: '/Root/input-topic',
    consumer: 'svc-a',
  })
  let writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/output-topic',
    producer: 'p1',
  })

  for await (let batch of reader.read({ limit: 1, signal })) {
    if (batch.length === 0) {
      continue
    }

    for (let message of batch) {
      writer.write(message.payload)
    }

    break
  }
})
```

Пример переносит одно сообщение между существующими топиками; для входного топика нужен consumer `svc-a`. `limit` ограничивает размер одной партии; явный `break` после непустой партии завершает чтение, чтобы callback мог перейти к коммиту. Если сообщение не появится до таймаута, операция завершится ошибкой.

Reader привязывает прочитанные offsets к транзакции и закрывается в `tx.onCommit`; Writer там же дожидается отправки буфера через `close()`. Cleanup hooks отвечают за закрытие при ошибке. Ручное закрытие внутри callback не требуется.

## Таймауты и повторные попытки

- Таймауты задавайте на уровне запроса или обработчика.
- Повторные попытки см. «Продвинутое → Повторные попытки и идемпотентность».

## Лучшие практики

- Держите транзакции короткими — минимизируйте блокировки и вероятность конфликтов.
- Для операций чтения используйте `snapshotReadOnly` при возможности.
- Идемпотентные операции упрощают повторные попытки; применяйте ключи идемпотентности, если нужно.
- Не смешивайте тяжёлые Topic‑операции и большие SQL‑чтения в одной транзакции без необходимости.
