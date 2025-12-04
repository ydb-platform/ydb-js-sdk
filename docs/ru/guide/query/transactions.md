---
title: Query — транзакции
---

# Транзакции в Query

В `@ydbjs/query` есть два удобных метода: `begin` и `transaction`.

- `begin(options?, fn)` — создаёт транзакцию, выполняет `fn(tx, signal)` и коммитит. В случае ошибки откатывает.
- `transaction(options?, fn)` — алиас `begin`.

Опции:

- `isolation?: 'serializableReadWrite' | 'snapshotReadOnly'` — уровень изоляции транзакции (по умолчанию `serializableReadWrite`).
- `idempotent?: boolean` — включает повторные попытки при условно‑повторяемых ошибках. Важно обеспечивать идемпотентность бизнес‑операции.

`signal: AbortSignal` внутри колбэка позволяет отменять долгие операции.

## Базовое использование

```ts
const result = await sql.begin(async (tx) => {
  await tx`UPDATE users SET active = false WHERE ...`
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

await sql.transaction(async (tx, signal) => {
  const reader = createTopicTxReader(tx, driver, {
    topic: '/Root/my-topic',
    consumer: 'svc-a',
  })
  for await (const batch of reader.read({ signal })) {
    // ...
  }

  const writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/my-topic',
    producer: 'p1',
  })
  writer.write(new TextEncoder().encode('message'))
})
```

Reader регистрирует `updateOffsetsInTransaction` в `tx.onCommit`, Writer — `flush` в `tx.onCommit`. Ручное закрытие внутри транзакции не требуется.

## Таймауты и повторные попытки

- Таймауты задавайте на уровне запроса или обработчика.
- Повторные попытки см. «Продвинутое → Повторные попытки и идемпотентность».

## Лучшие практики

- Держите транзакции короткими — минимизируйте блокировки и вероятность конфликтов.
- Для операций чтения используйте `snapshotReadOnly` при возможности.
- Идемпотентные операции упрощают повторные попытки; применяйте ключи идемпотентности, если нужно.
- Не смешивайте тяжёлые Topic‑операции и большие SQL‑чтения в одной транзакции без необходимости.
