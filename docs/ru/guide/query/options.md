---
title: Query — опции и API
---

# Опции и API `@ydbjs/query`

Клиент для SQL строкой, теговый интерфейс и настройки выполнения запросов.

## Клиент и базовый синтаксис

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

using driver = new Driver(process.env['YDB_CONNECTION_STRING'] ?? 'grpc://localhost:2136/local')
await driver.ready()

await using sql = query(driver)
let [rows] = await sql`SELECT 1 AS one`
```

### SQL строкой и границы повтора

`new QueryClient(driver)` предоставляет `retrySession(options, callback)` и `retryTransaction(options, callback)`; настройки можно опустить, callback всегда последний.
У корневого клиента нет `execute()` или `stream()`: эти методы доступны на исполнителе внутри callback.
`retrySession()` использует одну сессию на попытку, а `retryTransaction()` объединяет запросы в транзакцию.
Callback может выполниться несколько раз, поэтому создавайте накопители внутри него и учитывайте повтор внешних эффектов.
Дочитайте поток до выхода из callback; ранний `break` отменяет RPC и не считается успешным завершением.

```ts
import { QueryClient } from '@ydbjs/query'

type Row = { id: bigint }

await using client = new QueryClient(driver)

let result = await client.retrySession(
  { signal: AbortSignal.timeout(5000), idempotent: true },
  (session) => {
    return session.execute<[Row]>('SELECT $id AS id', { id: 42n })
  }
)

console.log(result.resultSets[0].rows[0]?.id)
```

`query(client)` создаёт теговый интерфейс с общим пулом и жизненным циклом.
`close()` ждёт завершения принятых операций; `destroy()` отменяет их немедленно.
Оба метода оставляют переданный `Driver` открытым; закройте его после клиентов.

### Результаты Temporal

Настройте преобразование при создании клиента: `query(driver, { temporal: true })` или `new QueryClient(driver, { temporal: true })`.
`query(client)` наследует настройку; она действует для обычных и потоковых результатов, включая вложенные значения.
Это опция клиента, а не метод запроса; на вывод типов параметров она не влияет.

Приложение должно предоставить `globalThis.Temporal` до создания клиента; SDK не устанавливает полифил.
Если среда не предоставляет Temporal, установите `temporal-polyfill` и импортируйте `temporal-polyfill/global` в точке входа приложения.
При отсутствии Temporal конструктор с `temporal: true` выбрасывает ошибку.
Raw-результаты обходят преобразование; TzDate и TzDate32 в обоих режимах остаются SDK Values.
См. [настройку и соответствие типов](https://github.com/ydb-platform/ydb-js-sdk/tree/main/packages/value#temporal-setup).

### Наборы результатов

`session.execute()` возвращает объект `QueryResult<T>` с полями `resultSets`, `stats` и `metadata`.
В каждом наборе доступны `rows`, `columns` и `truncated`; пустые наборы сохраняют свою позицию и схему колонок.
Tagged SQL возвращает массив массивов строк; статистика и метаданные доступны через методы и события объекта запроса.
Параметр типа — кортеж типов строк, по одному на каждый набор результатов; соответствие серверной схеме во время выполнения не проверяется.
Для потока по-прежнему указывается тип одной строки: `session.stream<Row>()` выдаёт части с `rows`, `columns`, `truncated` и `resultSetIndex` внутри callback ретраера.

```ts
import { QueryClient } from '@ydbjs/query'

type UserRow = { id: bigint }
type CountRow = { count: bigint }

let [users, counts] = await sql<[UserRow, CountRow]>`
  SELECT id FROM users;
  SELECT COUNT(*) AS count FROM users;
`

console.log(users[0]?.id, counts[0]?.count)

await using client = new QueryClient(driver)

let result = await client.retrySession((session) => {
  return session.execute<[UserRow, CountRow]>(
    'SELECT id FROM users; SELECT COUNT(*) AS count FROM users;'
  )
})

console.log(result.resultSets[0].rows[0]?.id, result.resultSets[1].rows[0]?.count)
console.log(
  result.resultSets[0].columns,
  result.resultSets[0].truncated,
  result.stats,
  result.metadata
)
```

## Методы настройки запроса

- `idempotent(flag?: boolean)` — помечает одиночный вызов как идемпотентный, что включает повторные попытки для кодов ошибок с «условной повторяемостью».
  - Внимание: игнорируется внутри `sql.begin`/`sql.transaction`.

- `isolation(mode, settings?)` — задаёт изоляцию для одиночного вызова.
  - Доступные режимы: `'implicit' | 'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite' | 'onlineReadOnly' | 'staleReadOnly'`.
  - Внутри активной транзакции изоляция задаётся только на уровне `sql.begin({ isolation })` / `sql.transaction(...)`. Применять `.isolation(...)` к `tx\`...\`` нельзя — она не действует для отдельного запроса.

- `timeout(ms: number)` — общий таймаут выполнения одиночного запроса; учитывается при формировании AbortSignal.

- `withStats(mode)` и `stats()` — включает сбор статистики (QueryStats) и позволяет получить её после await:
  - mode: StatsMode.<...> из `@ydbjs/api/query` (например, StatsMode.FULL).

- `values()` и `raw()` — форматы результата:
  - По умолчанию: каждый набор содержит объекты `{ columnName: value }`.
  - `values()`: каждый набор содержит строки в виде массивов значений в порядке колонок.
  - `raw()`: вернуть protobuf-значения `Ydb.Value` без конвертации в JS. Их типы доступны в результате `QueryClient` через `result.resultSets[0].columns`.

- `syntax(mode)` — синтаксис текста (по умолчанию `YQL_V1`).

- `pool(poolId)` — назначение пула (если сконфигурирован на стороне YDB Query сервисов).

- `parameter(name, value)` / `param(name, value)` — привязать JS-значение или явный YDB Value по имени. Передайте `undefined`, чтобы удалить привязку.

- `signal(abortSignal)` — задать внешний сигнал отмены. Повторный вызов заменяет его; для нескольких сигналов используйте `AbortSignal.any()`.

- `execute()` — запустить выполнение и вернуть тот же `Query<T>`. Дождитесь объекта через `await`, чтобы получить результат или ошибку.

- `cancel()` — отменить выполнение. Эквивалентно `controller.abort()` для внутреннего AbortController.

## События запроса

На экземпляре `Query<T>` доступны события (через `on(event, listener)`):

- `retry` — получает `RetryContext` при повторе самостоятельного запроса. Для повтора callback используйте опцию `onRetry` у `retrySession()` или `retryTransaction()`.
- `stats` — статистика выполнения, если включена `withStats()`.
- `done` — получает массив наборов результатов, каждый набор — массив строк, как при `await query`.
- `error` — получает ошибку выполнения, если на событие есть подписчик. Дождитесь запроса через `await`, чтобы обработать его отказ.
- `cancel` — событие без аргументов при явном вызове `query.cancel()`. Отмена внешним сигналом и таймаут не публикуют это событие.
- `metadata` — gRPC трейлеры (например, server hints/headers).

```ts
import { StatsMode } from '@ydbjs/api/query'

let q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)

q.on('retry', (ctx) => {
  console.log('retry', ctx.attempt, ctx.error)
})

q.on('stats', (s) => {
  console.log('cpu(us)', s.totalCpuTimeUs)
})

await q
```

## Параметры и типы

Значения в `${...}` передаются как параметры через `@ydbjs/value`; `identifier()`, `fragment()` и `unsafe()` добавляют структуру SQL.

- Именованные параметры:

```ts
await sql`SELECT $id AS id`.parameter('id', 42)
```

- Комплексные типы (массивы, структуры) и табличные параметры через `AS_TABLE(${arrayOfObjects})`.

- Динамические идентификаторы и «небезопасные» фрагменты:
  - `sql.identifier(name)` — экранирует имя таблицы/колонки.
  - `sql.unsafe(text)` — для доверенных миграций/сервисных запросов; не передавайте туда пользовательские данные.

## Ошибки и повторные попытки

Запрос выбрасывает `YDBError` (или другие ошибки) при неуспехе. Повторные попытки управляются флагом `idempotent()` и кодами ошибок.

- Статусы YDB `ABORTED/OVERLOADED/UNAVAILABLE/BAD_SESSION/SESSION_BUSY` допускают повтор, пока хватает бюджета callback и операция не отменена.
- Статусы YDB `SESSION_EXPIRED/UNDETERMINED/TIMEOUT` требуют `idempotent(true)`. Для транспорта действует отдельное правило: gRPC `INTERNAL` и `UNAVAILABLE` тоже требуют идемпотентности. Отмена вызывающим кодом и локальный таймаут завершают операцию.

```ts
try {
  await sql`SELECT * FROM heavy_table`.idempotent(true).timeout(5000)
} catch (e) {
  // e instanceof YDBError
}
```
