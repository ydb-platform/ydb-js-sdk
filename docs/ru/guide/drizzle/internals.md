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
let fromString = new YdbDriver('grpc://localhost:2136/local')

// 2. Из существующего экземпляра Driver SDK
using sdkDriver = new Driver('grpc://localhost:2136/local')
let driver = new YdbDriver(sdkDriver)
```

**Примечание:** Если `YdbDriver` создает SDK-драйвер самостоятельно (через строку подключения), он владеет им и закроет его при вызове `driver.close()`.

### Основные методы

- `await driver.ready(signal?)`: Проверяет готовность драйвера и наличие соединения.
- `await driver.execute(yql, params, method, options?)`: Низкоуровневое выполнение YQL.
- `await driver.transaction(callback, config?)`: Низкоуровневое выполнение транзакции.
- `driver.close()`: Освобождает ресурсы драйвера. Синхронный; возвращает `void`.

## YdbSession

`YdbSession` представляет контекст одной сессии базы данных. Она служит мостом между драйвером, диалектом и логгером.

### Основные методы

- `.all()`, `.get()`, `.values()`, `.execute()`: Выполнение одиночных запросов в разных форматах.
- `.prepareQuery(...)`: Внутренний метод, используемый публичным `.prepare()` построителя запросов.
- `.batch([queries])`: Выполняет запросы последовательно; сам по себе не создаёт транзакцию и не закрепляет серверную сессию.
- `.count(query)`: Эффективное получение количества строк.
- `.transaction(callback)`: Запуск транзакционной сессии.

### YdbPreparedQuery

`.prepare()` создаёт объект для повторного выполнения с уже сгенерированным YQL и значениями, переданными в построитель. Методы выполнения не принимают параметры; для других значений создайте новый запрос. Именованные placeholders и серверные prepared statements не поддерживаются.

Необязательное имя в `prepare(name?)` принимается, но сейчас игнорируется.

```ts
import { eq } from 'drizzle-orm'

let prepared = db.select().from(users).where(eq(users.id, 1)).prepare()

await prepared.execute()
```

## YdbDialect

`YdbDialect` отвечает за преобразование абстрактных структур запросов Drizzle в синтаксис YQL и маппинг типов.

### Особенности

- **Экранирование:** Методы `escapeName()`, `escapeParam()` и `escapeString()` для безопасной генерации SQL.
- **Рендеринг:** Низкоуровневые методы (`buildSelectQuery`, `buildInsertQuery` и др.), используемые построителями запросов.
- **Миграции:** Управляет низкоуровневой логикой миграций, включая работу с таблицей истории и проверку хешей.

### Генерация YQL

`YdbDialect.sqlToQuery()` используется внутри адаптера. В приложении вызывайте `.toSQL()` у построителя:

```ts
import { eq } from 'drizzle-orm'

let { sql: query, params } = db.select().from(users).where(eq(users.id, 1)).toSQL()
```
