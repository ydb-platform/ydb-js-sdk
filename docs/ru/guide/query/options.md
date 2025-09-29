title: Query — Options & API
---

# Options and API `@ydbjs/query`

This page provides a full overview of the query client API and its chainable options.

## Client and basic syntax

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

let driver = new Driver(process.env.YDB_CONNECTION_STRING!)
await driver.ready()

let sql = query(driver)
let rows = await sql`SELECT 1 AS one`
```

## Chainable query options

- `idempotent(flag?: boolean)` — marks a single call as idempotent, which enables retries for conditionally retryable error codes.
  - Note: ignored inside `sql.begin`/`sql.transaction`.

- `isolation(mode, settings?)` — sets isolation for a single call.
  - Modes: `'implicit' | 'serializableReadWrite' | 'snapshotReadOnly' | 'onlineReadOnly' | 'staleReadOnly'`.
  - Inside an active transaction, isolation is configured only at `sql.begin({ isolation })` / `sql.transaction(...)`. Applying `.isolation(...)` to `tx\`...\`` has no effect for a single statement.

- `timeout(ms: number)` — total timeout for a single call; used when composing the AbortSignal.

- `withStats(mode)` and `stats()` — enables QueryStats and lets you access them after await:
  - mode: StatsMode.<...> from `@ydbjs/api/query` (e.g., StatsMode.FULL).

- `values()` and `raw()` — result formats:
  - Default: array of objects `{ columnName: value }`.
  - `values()`: array of arrays in column order.
  - `raw()`: return raw wire values (TypedValue) without converting to JS.

- `syntax(mode)` — text syntax (default `YQL_V1`).

- `pool(poolId)` — target pool (if configured server‑side by YDB Query services).

- `parameter(name, value)` / `param(name, value)` — add/override a named parameter.

- `signal(abortSignal)` — merge an external AbortSignal.

- `execute()` — start execution “from outside” and get the same `Query<T>` (useful for fire‑and‑forget with events).

- `cancel()` — cancel execution. Equivalent to `controller.abort()` for the internal AbortController.

## Query events

`Query<T>` instances emit events via `on(event, listener)`:

- `retry` — fired on retry; good for logging.
- `stats` — execution stats if `withStats()` is enabled.
- `done` — completed with result.
- `error` — execution error.
- `cancel` — user cancellation.
- `metadata` — gRPC trailers (e.g., server hints/headers).

```ts
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
q.on('retry', (ctx) => console.log('retry', ctx.attempt, ctx.error))
q.on('stats', (s) => console.log('cpu', s.queryPhaseStats?.cpuTimeUs))
await q
```

## Parameters and types

Interpolations `${...}` are always parameterized and automatically converted through `@ydbjs/value`.

- Named parameters:

```ts
await sql`SELECT * FROM users WHERE id = $id`.parameter('id', 42)
```

- Complex types (arrays, structs) and table parameters via `AS_TABLE(${arrayOfObjects})`.

- Dynamic identifiers and “unsafe” fragments:
  - `sql.identifier(name)` — escapes and quotes table/column identifiers.
  - `sql.unsafe(text)` — for trusted migrations/service statements; never pass user input.

## Errors and retries

Queries throw `YDBError` (or others) on failure. Retries are governed by `idempotent()` and error codes.

- `ABORTED/OVERLOADED/UNAVAILABLE/BAD_SESSION/SESSION_BUSY` — always retried.
- `SESSION_EXPIRED/UNDETERMINED/TIMEOUT` — retried only with `idempotent(true)`.

```ts
try {
  await sql`SELECT * FROM heavy_table`.idempotent(true).timeout(5000)
} catch (e) {
  // e instanceof YDBError
}
```
---
title: Query — опции и API
---

# Опции и API `@ydbjs/query`

Ниже — полный обзор API клиента запросов и чейнируемых опций.

## Клиент и базовый синтаксис

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

let driver = new Driver(process.env.YDB_CONNECTION_STRING!)
await driver.ready()

let sql = query(driver)
let rows = await sql`SELECT 1 AS one`
```

## Чейнируемые опции запроса

- `idempotent(flag?: boolean)` — помечает одиночный вызов как идемпотентный, что включает повторные попытки для кодов ошибок с «условной повторяемостью».
  - Внимание: игнорируется внутри `sql.begin`/`sql.transaction`.

- `isolation(mode, settings?)` — задаёт изоляцию для одиночного вызова.
  - Доступные режимы: `'implicit' | 'serializableReadWrite' | 'snapshotReadOnly' | 'onlineReadOnly' | 'staleReadOnly'`.
  - Внутри активной транзакции изоляция задаётся только на уровне `sql.begin({ isolation })` / `sql.transaction(...)`. Применять `.isolation(...)` к `tx\`...\`` нельзя — она не действует для отдельного запроса.

- `timeout(ms: number)` — общий таймаут выполнения одиночного запроса; учитывается при формировании AbortSignal.

- `withStats(mode)` и `stats()` — включает сбор статистики (QueryStats) и позволяет получить её после await:
  - mode: StatsMode.<...> из `@ydbjs/api/query` (например, StatsMode.FULL).

- `values()` и `raw()` — форматы результата:
  - По умолчанию: массив объектов `{ columnName: value }`.
  - `values()`: массив массивов значений в порядке колонок.
  - `raw()`: вернуть «сырые» wire‑значения (TypedValue) без конвертации в JS.

- `syntax(mode)` — синтаксис текста (по умолчанию `YQL_V1`).

- `pool(poolId)` — назначение пула (если сконфигурирован на стороне YDB Query сервисов).

- `parameter(name, value)` / `param(name, value)` — добавить/переопределить именованный параметр.

- `signal(abortSignal)` — подмешать внешний AbortSignal.

- `execute()` — запустить выполнение «извне» и получить тот же `Query<T>` (удобно для fire‑and‑forget с событиями).

- `cancel()` — отменить выполнение. Эквивалентно `controller.abort()` для внутреннего AbortController.

## События запроса

На экземпляре `Query<T>` доступны события (через `on(event, listener)`):

- `retry` — срабатывает при повторе; полезно для логирования.
- `stats` — статистика выполнения, если включена `withStats()`.
- `done` — завершение с результатом.
- `error` — ошибка выполнения.
- `cancel` — отмена исполнения пользователем.
- `metadata` — gRPC трейлеры (например, server hints/headers).

```ts
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
q.on('retry', (ctx) => console.log('retry', ctx.attempt, ctx.error))
q.on('stats', (s) => console.log('cpu', s.queryPhaseStats?.cpuTimeUs))
await q
```

## Параметры и типы

Интерполяции `${...}` всегда параметризуются и автоматически конвертируются через `@ydbjs/value`.

- Именованные параметры:

```ts
await sql`SELECT * FROM users WHERE id = $id`.parameter('id', 42)
```

- Комплексные типы (массивы, структуры) и табличные параметры через `AS_TABLE(${arrayOfObjects})`.

- Динамические идентификаторы и «небезопасные» фрагменты:
  - `sql.identifier(name)` — экранирует имя таблицы/колонки.
  - `sql.unsafe(text)` — для доверенных миграций/сервисных запросов; не передавайте туда пользовательские данные.

## Ошибки и повторные попытки

Запрос выбрасывает `YDBError` (или другие ошибки) при неуспехе. Повторные попытки управляются флагом `idempotent()` и кодами ошибок.

- Коды `ABORTED/OVERLOADED/UNAVAILABLE/BAD_SESSION/SESSION_BUSY` — повторяются всегда.
- Коды `SESSION_EXPIRED/UNDETERMINED/TIMEOUT` — повторяются только при `idempotent(true)`.

```ts
try {
  await sql`SELECT * FROM heavy_table`.idempotent(true).timeout(5000)
} catch (e) {
  // e instanceof YDBError
}
```
