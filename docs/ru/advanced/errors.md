---
title: Обработка ошибок
---

# Обработка ошибок

Классы ошибок и паттерны обработки, применяемые в SDK.

## Классы ошибок

- `YDBError` — серверная ошибка YDB с полями `code` и `issues`.
- `CommitError` — неудачный коммит; содержит `retryable(idempotent)`.
- `ClientError` — gRPC‑ошибка на стороне клиента (например, `UNAVAILABLE`).

Используйте `instanceof` для ветвления логики.

```ts
import { YDBError } from '@ydbjs/error'

try {
  await sql`SELECT * FROM t`
} catch (e) {
  if (e instanceof YDBError) {
    console.error('YDB code:', e.code)
  }
  throw e
}
```

## Статистика запроса для диагностики

```ts
import { StatsMode } from '@ydbjs/api/query'

const q = sql`SELECT * FROM t`.withStats(StatsMode.FULL)
q.on('stats', (s) => console.log('cpu(us)=', s.queryPhaseStats?.cpuTimeUs))
await q
```

## Таймауты и отмена

Компонируйте `AbortSignal` по всему стеку. Предпочитайте `.timeout(ms)` на вызов и передавайте внешний `signal` при оркестрации нескольких операций.

## Логирование и отладка

Включайте debug‑логи для трассировки сбоев: `DEBUG=ydbjs:*`. См. «Расширенные темы → Debug‑логирование».

## Ретраи

Используйте `.idempotent(true)` для безопасных повторов одиночных вызовов, обеспечив идемпотентность бизнес‑логики. См. «Расширенные темы → Повторные попытки».
