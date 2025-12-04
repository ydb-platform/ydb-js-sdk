---
title: Query — обзор
---

# Query (packages/query)

Высокоуровневый, типобезопасный клиент для YQL‑запросов и транзакций.

## Быстрый старт

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const sql = query(driver)
const rows = await sql`SELECT 1 + 1 AS sum`
console.log(rows)
```

## Примеры {#examples}

### Параметры и AS_TABLE {#examples-parameters}

```ts
const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
]
await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`
```

### Именованные параметры {#examples-named-parameters}

```ts
await sql`SELECT * FROM users WHERE id = $id`.parameter('id', 42)
```

### Получение статистики {#examples-stats}

```ts
import { StatsMode } from '@ydbjs/api/query'

const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
q.on('stats', (s) => console.log('Stats:', s))
await q
```

### Форматы результата {#examples-results}

```ts
// Массив значений (в порядке колонок)
const vals = await sql`SELECT 1 AS a, 2 AS b`.values()
console.log(vals) // [ [1, 2] ]

// Сырые TypedValue
const raw = await sql`SELECT 1`.raw()
```

### Изоляция одиночного вызова {#examples-isolation}

```ts
await sql`SELECT * FROM users`.isolation('snapshotReadOnly').timeout(3000)
```

### Обработка ошибок {#examples-errors}

```ts
import { YDBError } from '@ydbjs/error'

try {
  await sql`SELECT * FROM non_existent`
} catch (e) {
  if (e instanceof YDBError) {
    console.error('YDB error code:', e.code)
  }
}
```

### Динамические идентификаторы и небезопасные фрагменты {#examples-identifiers}

```ts
// Безопасные динамические имена таблиц/колонок
const table = sql.identifier('users')
const column = sql.identifier('created_at')
const rows = await sql`SELECT ${column} FROM ${table} WHERE id = ${42}`

// Небезопасные фрагменты — только для доверенного кода (миграции, DDL)
await sql`PRAGMA TablePathPrefix(${sql.unsafe('/Root/dev')});`
```

### События запроса и ретраи {#examples-events}

```ts
import { StatsMode } from '@ydbjs/api/query'

const q = sql`SELECT * FROM heavy_table`
  .idempotent(true)
  .withStats(StatsMode.FULL)

q.on('retry', (ctx) => console.log('retry attempt', ctx.attempt, ctx.error))
q.on('stats', (s) => console.log('cpu(us)=', s.queryPhaseStats?.cpuTimeUs))
await q
```

### Отмена и таймауты {#examples-cancel}

```ts
const ac = new AbortController()
setTimeout(() => ac.abort('user cancelled'), 1000)

await sql`SELECT pg_sleep(10)`.timeout(5000).signal(ac.signal)
```

### Режимы изоляции {#examples-isolation-modes}

```ts
// Snapshot read-only одиночная транзакция
await sql`SELECT COUNT(*) FROM users`.isolation('snapshotReadOnly')

// Online read-only с разрешением неконсистентных чтений
await sql`SELECT COUNT(*) FROM users`.isolation('onlineReadOnly', {
  allowInconsistentReads: true,
})
```

### Syntax и pool {#examples-syntax-pool}

```ts
import { Syntax } from '@ydbjs/api/query'

await sql`SELECT 1`.syntax(Syntax.YQL_V1)
await sql`SELECT 1`.pool('analytics')
```

### Хуки транзакции {#examples-tx-hooks}

```ts
const result = await sql.begin(async (tx, signal) => {
  tx.onCommit(() => console.log('committing tx', tx.transactionId))
  tx.onRollback((err) => console.log('rolling back tx', err))

  await tx`UPSERT INTO audit(id, ts) VALUES (${1}, CurrentUtcDatetime())`
  return await tx`SELECT * FROM audit WHERE id = ${1}`
})
```
