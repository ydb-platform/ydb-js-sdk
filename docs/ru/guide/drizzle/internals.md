---
title: Drizzle Adapter — Драйвер, Сессия, Диалект
---

# Внутренние компоненты: Driver, Session, Dialect

Понимание низкоуровневых компонентов адаптера YDB для Drizzle: `YdbDriver`, `YdbSession` и `YdbDialect`.

Корневым runtime-экспортом является только `YdbDriver`. `YdbSession` и `YdbDialect` — детали реализации адаптера; они описаны здесь для понимания поведения, а не как стабильные конструкторы для кода приложения.

## YdbDriver

`YdbDriver` передаёт YQL и именованные параметры в `QueryClient` из `@ydbjs/query`. Одиночный запрос выполняется через `retrySession()`, транзакция — через `retryTransaction()`.

Каждая попытка выполнить одиночный запрос читает текущие типы и значения параметров. Изменения буфера, типизированного значения или массива параметров между попытками попадут в повторный запрос. Если все попытки должны использовать одинаковые значения, сохраняйте входные данные неизменными до завершения операции.

При повторе транзакции callback выполняется заново, включая построение запросов и их параметров. Если все попытки должны использовать одинаковые входные данные, подготовьте их до входа в callback и не меняйте до завершения транзакции.

### Инициализация

```ts
import { Driver } from '@ydbjs/core'
import { YdbDriver } from '@ydbjs/drizzle-adapter'

// 1. Из строки подключения
let fromString = new YdbDriver('grpc://localhost:2136/local')

// 2. Из существующего экземпляра Driver SDK
let sdkDriver = new Driver('grpc://localhost:2136/local')
let driver = new YdbDriver(sdkDriver)
```

Вызов `driver.close()` освобождает пул и драйвер, созданные адаптером. Если передать `new YdbDriver(client)` существующий `QueryClient`, и пулом, и драйвером продолжает управлять приложение.

### Основные методы

- `await driver.ready(signal?)`: Проверяет готовность драйвера и наличие соединения.
- `await driver.execute(yql, params, method, options?)`: Низкоуровневое выполнение YQL.
- `await driver.transaction(callback, config?)`: Низкоуровневое выполнение транзакции.
- `driver.close()`: Освобождает ресурсы драйвера. Синхронный; возвращает `void`.

## YdbSession

`YdbSession` готовит запросы Drizzle, записывает их в лог и сопоставляет результаты с выбранными полями. За сессию YDB отвечает `QueryClient`: он берёт её из пула для каждой попытки выполнить одиночный запрос или транзакцию.

### Основные методы

- `.all()`, `.get()`, `.values()`, `.execute()`: Выполнение одиночных запросов в разных форматах.
- `.prepareQuery(sql, fields, name, arrayMode)`: Создает `YdbPreparedQuery` для повторного использования.
- `.batch([queries])`: Выполняет запросы последовательно. Внутри транзакции они используют её сессию.
- `.count(query)`: Эффективное получение количества строк.
- `.transaction(callback)`: Запуск транзакционной сессии.

### YdbPreparedQuery

Объект, возвращаемый методом `.prepare()`, позволяет выполнять один и тот же запрос с разными параметрами без повторного парсинга YQL.

```ts
import { sql } from 'drizzle-orm'

// `session` берётся из вызова YdbDriver (например, внутри `db.transaction`).
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
import { sql } from 'drizzle-orm'

const dialect = new YdbDialect()
const { sql: query, params } = dialect.sqlToQuery(sql`SELECT * FROM users WHERE id = ${1}`)
// query  -> "SELECT * FROM users WHERE id = $p0"
// params -> [1]
```
