# @ydbjs/query

Читать на английском: [README.md](README.md)

`@ydbjs/query` — высокоуровневый, типобезопасный клиент для выполнения YQL‑запросов и управления транзакциями в YDB. Поддерживает теговый шаблонный синтаксис, автоматическое связывание параметров, хелперы транзакций и глубокую интеграцию с типовой системой YDB.

## Возможности

- Теговый шаблонный синтаксис для YQL
- Типобезопасное связывание параметров (включая сложные/вложенные типы)
- Транзакции с настройками изоляции и идемпотентности
- Несколько результирующих наборов и стриминг
- Статистика выполнения и диагностика
- Полные типы TypeScript

## Установка

```sh
npm install @ydbjs/core@alpha @ydbjs/query@alpha
```

## Как это работает

- **Query‑клиент**: создайте клиент `query(driver)`. Он возвращает теговую функцию для YQL и хелперы транзакций.
- **Сессии и транзакции**: управление жизненным циклом выполняется автоматически. Можно запускать одиночные запросы или объединять несколько запросов в транзакцию через `begin`/`transaction`.
- **Параметры**: параметры передаются через интерполяцию (`${}`) в шаблоне. Поддерживаются нативные типы JS, классы значений YDB и массивы/объекты. Для именованных параметров используйте `.parameter()`/`.param()`.
- **Безопасность типов**: все значения конвертируются с помощью `@ydbjs/value`. Сложные и вложенные типы обрабатываются автоматически.
- **Результаты**: YDB может возвращать несколько наборов результатов за один запрос.
- **Статистика**: используйте `.withStats()` или `.stats()` для доступа к статистике выполнения.

## Использование

### Быстрый старт

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const sql = query(driver)
const resultSets = await sql`SELECT 1 + 1 AS sum`
console.log(resultSets) // [ [ { sum: 2 } ] ]
```

### Параметризованные запросы

```ts
const userId = 42n
const userName = 'Alice'
await sql`
  SELECT * FROM users
  WHERE id = ${userId} AND name = ${userName}
`
```

#### Именованные параметры и кастомные типы

```ts
import { Uint64 } from '@ydbjs/value/primitive'
const id = new Uint64(123n)
await sql`SELECT * FROM users WHERE id = $id`.parameter('id', id)
```

#### Массивы, структуры и табличные параметры

```ts
const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
]
await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`
```

### Транзакции

```ts
// Serializable read-write (по умолчанию)
const result = await sql.begin(async (tx) => {
  await tx`UPDATE users SET active = false WHERE last_login < CurrentUtcTimestamp() - Interval('P1Y')`
  return await tx`SELECT * FROM users WHERE active = false`
})

// С изоляцией и идемпотентностью
await sql.begin(
  { isolation: 'snapshotReadOnly', idempotent: true },
  async (tx) => {
    return await tx`SELECT COUNT(*) FROM users`
  }
)
```

### Продвинутое: несколько наборов результатов, стриминг и события

```ts
import { StatsMode } from '@ydbjs/api/query'
// Несколько наборов результатов
type Result = [[{ id: number }], [{ count: number }]]
const [rows, [{ count }]] =
  await sql<Result>`SELECT id FROM users; SELECT COUNT(*) as count FROM users;`

// Подписка на статистику и ретраи
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
q.on('stats', (stats) => console.log('Query stats:', stats))
q.on('retry', (ctx) => console.log('Retrying:', ctx))
await q
```

### Обработка ошибок

```ts
import { YDBError } from '@ydbjs/error'
try {
  await sql`SELECT * FROM non_existent_table`
} catch (e) {
  if (e instanceof YDBError) {
    console.error('YDB Error:', e.message)
  }
}
```

### Опции запроса и чейнинг

```ts
import { StatsMode } from '@ydbjs/api/query'
await sql`SELECT * FROM users`
  .isolation('onlineReadOnly', { allowInconsistentReads: true })
  .idempotent(true)
  .timeout(5000)
  .withStats(StatsMode.FULL)
```

Внимание: эти опции действуют только для одиночных запросов (один вызов execute). Внутри транзакций (sql.begin/sql.transaction) они игнорируются.

### Конвертация значений и безопасность типов

Все значения конвертируются с помощью `@ydbjs/value`. См. документацию `@ydbjs/value` по типам и правилам конвертации. Можно передавать нативные типы JS или использовать классы YDB для полного контроля.

```ts
import { fromJs } from '@ydbjs/value'
await sql`SELECT * FROM users WHERE meta = ${fromJs({ foo: 'bar' })}`
```

## Статистика запросов

```ts
import { StatsMode } from '@ydbjs/api/query'
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
await q
console.log(q.stats())
```

## Идентификаторы и небезопасные фрагменты

- Динамические имена таблиц/колонок — используйте идентификаторы:

```ts
// Метод клиента
await sql`SELECT * FROM ${sql.identifier('users')}`

// Или импорт из пакета
import { identifier } from '@ydbjs/query'
await sql`SELECT * FROM ${identifier('users')}`
```

- Небезопасные фрагменты — только для доверенных сценариев (не с данными пользователя):

```ts
import { unsafe } from '@ydbjs/query'
await sql`SELECT * FROM users ${unsafe('ORDER BY created_at DESC')}`
```

Заметка по безопасности: identifier() лишь экранирует обратные кавычки и оборачивает имя в обратные кавычки. Не передавайте туда непроверенный ввод — используйте валидацию/allow‑list.

## Разработка

### Сборка

```sh
npm run build
```

### Тесты

```sh
npm test
```

## Настройки для AI ассистентов

Этот пакет содержит примеры конфигураций для AI‑ассистентов в каталоге `ai-instructions/`, чтобы генерировать безопасный YQL‑код.

Быстрый старт:

```bash
# Для Cursor AI
cp node_modules/@ydbjs/query/ai-instructions/.cursorrules.example .cursorrules

# Для GitHub Copilot
cp node_modules/@ydbjs/query/ai-instructions/.copilot-instructions.example.md .copilot-instructions.md

# Для прочих ассистентов
cp node_modules/@ydbjs/query/ai-instructions/.instructions.example.md .instructions.md
# ИЛИ
cp node_modules/@ydbjs/query/ai-instructions/.ai-instructions.example.md .ai-instructions.md
```

См. `SECURITY.md` для полного руководства по безопасности.

## Лицензия

Проект распространяется по лицензии [Apache 2.0](../../LICENSE).

## Ссылки

- Документация YDB: https://ydb.tech
- Репозиторий: https://github.com/ydb-platform/ydb-js-sdk
- Issues: https://github.com/ydb-platform/ydb-js-sdk/issues
