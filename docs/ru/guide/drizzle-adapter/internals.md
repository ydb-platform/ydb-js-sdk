---
title: Drizzle Adapter — Драйвер, Сессия, Диалект
---

# Внутренние компоненты: Driver, Session, Dialect

Понимание низкоуровневых компонентов адаптера YDB для Drizzle: `YdbDriver`, `YdbSession` и `YdbDialect`.

Корневым runtime-экспортом является только `YdbDriver`. `YdbSession` и `YdbDialect` — детали реализации адаптера; они описаны здесь для понимания поведения, а не как стабильные конструкторы для кода приложения.

## YdbDriver

`YdbDriver` — это низкоуровневый компонент, обеспечивающий взаимодействие между Drizzle ORM и основным драйвером `@ydbjs/core`.

### Инициализация

```ts
import { Driver } from '@ydbjs/core'
import { YdbDriver } from '@ydbjs/drizzle-adapter'

// 1. Из строки подключения
const fromString = new YdbDriver('grpc://localhost:2136/local')

// 2. Из существующего экземпляра Driver SDK
const sdkDriver = new Driver({
  /* ... */
})
const driver = new YdbDriver(sdkDriver)
```

**Примечание:** Если `YdbDriver` создает SDK-драйвер самостоятельно (через строку подключения), он владеет им и закроет его при вызове `driver.close()`.

### Основные методы

- `await driver.ready(signal?)`: Проверяет готовность драйвера и наличие соединения.
- `await driver.execute(yql, params, method, options?)`: Низкоуровневое выполнение YQL.
- `await driver.transaction(callback, config?)`: Низкоуровневое выполнение транзакции.
- `await driver.close()`: Освобождает ресурсы драйвера.

## YdbSession

`YdbSession` представляет контекст одной сессии базы данных. Она служит мостом между драйвером, диалектом и логгером.

### Основные методы

- `.all()`, `.get()`, `.values()`, `.execute()`: Выполнение одиночных запросов в разных форматах.
- `.prepareQuery(sql, fields, name, arrayMode)`: Создает `YdbPreparedQuery` для повторного использования.
- `.batch([queries])`: Последовательное выполнение нескольких запросов в рамках одной сессии.
- `.count(query)`: Эффективное получение количества строк.
- `.transaction(callback)`: Запуск транзакционной сессии.

### YdbPreparedQuery

Объект, возвращаемый методом `.prepare()`, позволяет выполнять один и тот же запрос с разными параметрами без повторного парсинга YQL.

```ts
const prepared = session.prepareQuery(
  sql`SELECT * FROM users WHERE id = ${sql.placeholder('id')}`,
  undefined,
  'select_user'
)

await prepared.execute({ id: 1 })
```

## YdbDialect

`YdbDialect` отвечает за преобразование абстрактных структур запросов Drizzle в синтаксис YQL и маппинг типов.

### Особенности

- **Экранирование:** Методы `escapeName()`, `escapeParam()` и `escapeString()` для безопасной генерации SQL.
- **Рендеринг:** Низкоуровневые методы (`buildSelectQuery`, `buildInsertQuery` и др.), используемые построителями запросов.
- **Миграции:** Управляет низкоуровневой логикой миграций, включая работу с таблицей истории и проверку хешей.

### sqlToQuery

Преобразует шаблон `sql` Drizzle в YQL с плейсхолдерами для параметров.

```ts
const { sql, params } = dialect.sqlToQuery(sql`SELECT * FROM users WHERE id = ${1}`)
// Результат -> sql: "SELECT * FROM users WHERE id = $p0", params: [1]
```
