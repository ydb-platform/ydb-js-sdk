---
title: Повторные попытки и идемпотентность
---

# Повторные попытки и идемпотентность

Как устроены ретраи в SDK и когда включать идемпотентность.

## Обзор политики ретраев

Ретраи реализованы пакетом `@ydbjs/retry` с разумными значениями по умолчанию:

- Мгновенный повтор для `BAD_SESSION`, `SESSION_EXPIRED`, `ABORTED`.
- Экспоненциальная задержка для `OVERLOADED` и gRPC `RESOURCE_EXHAUSTED` (начиная с 1000 мс).
- Экспоненциальная задержка для остальных ретраебельных случаев (начиная с 10 мс).
- Бюджет попыток по умолчанию бесконечный; ограничьте через `budget`.

Ретраи запросов зависят от флага идемпотентности:

- Всегда повторяются: `ABORTED`, `OVERLOADED`, `UNAVAILABLE`, `BAD_SESSION`, `SESSION_BUSY`.
- Условные (только с `.idempotent(true)`): `SESSION_EXPIRED`, `UNDETERMINED`, `TIMEOUT`.

См. реализацию: `packages/retry/src/index.ts` и `packages/query/src/query.ts`.

## Пометка одиночного вызова как идемпотентного

```ts
await sql`UPDATE counters SET v = v + 1 WHERE id = ${id}`
  .idempotent(true)
  .timeout(3000)
```

Внутри `sql.begin`/`sql.transaction` пометка на уровне одного вызова игнорируется; настраивайте идемпотентность на уровне транзакции и делайте бизнес‑логику идемпотентной (например, через ключи идемпотентности).

## Кастомизация стратегии ретраев

```ts
import { retry, defaultRetryConfig, strategies } from '@ydbjs/retry'

await retry({
  ...defaultRetryConfig,
  budget: 5,
  strategy: strategies.exponential(200),
}, async (signal) => {
  return await sql`SELECT 1`.signal(signal)
})
```

## Topic streaming

Topic reader/writer переподнимают соединение при сбоях и пересоздают очередь команд. Для writer можно настраивать `retryConfig`; обеспечивайте идемпотентность продюсера через `producerId + seqNo`.

## Рекомендации

- Предпочитайте идемпотентные операции и используйте ключи идемпотентности в сценариях at‑least‑once.
- Ставьте явные таймауты, чтобы ограничивать «хвосты» по времени.
- Логируйте ретраи через `on('retry')` и включайте `DEBUG=ydbjs:*` на стендах.
