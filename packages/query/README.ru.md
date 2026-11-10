# @ydbjs/query

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=query)](https://codecov.io/gh/ydb-platform/ydb-js-sdk)

Читать на английском: [README.md](README.md)

`@ydbjs/query` предоставляет теговый API и клиент для выполнения YQL строкой и управления транзакциями в YDB. Они используют общее преобразование параметров, пул сессий и обработку повторов.

## Возможности

- Теговый шаблонный синтаксис для YQL
- SQL строкой и потоковое чтение внутри явных retry callback
- Типобезопасное связывание параметров (включая сложные/вложенные типы)
- Транзакции с настройками изоляции и идемпотентности
- Несколько результирующих наборов и стриминг
- Статистика выполнения и диагностика
- Полные типы TypeScript

## Установка

```sh
npm install @ydbjs/core @ydbjs/query
```

## Как это работает

- **Теговые запросы**: `query(driver)` возвращает теговую функцию для YQL с автоматическим связыванием параметров и методами работы с транзакциями.
- **Клиент для SQL строкой**: `new QueryClient(driver)` предоставляет `retrySession(options, callback)` и `retryTransaction(options, callback)`. Настройки можно опустить; callback всегда передаётся последним. Он получает сессию или транзакцию и сигнал отмены текущей попытки. `query(client)` добавляет теговый интерфейс с общим пулом и жизненным циклом.
- **Пул сессий**: сессии автоматически переиспользуются между запросами и транзакциями (размер пула по умолчанию: 50). Настройка: `query(driver, { poolOptions: { maxSize: 100 } })`.
- **Сессии и транзакции**: управление жизненным циклом выполняется автоматически. Можно запускать одиночные запросы или объединять несколько запросов в транзакцию через `begin`/`transaction`.
- **Параметры.** В шаблон, в `.parameter()` (или `.param()`) и в объект параметров для `execute()` или `stream()` можно передавать обычные значения JavaScript. SDK сам определяет их типы YDB. Если запросу нужен конкретный тип YDB, используйте соответствующий класс из SDK.
- **Безопасность типов**: все значения конвертируются с помощью `@ydbjs/value`. Сложные и вложенные типы обрабатываются автоматически.
- **Результаты**: YDB может возвращать несколько наборов результатов за один запрос.
- **Статистика**: используйте `.withStats()` или `.stats()` для доступа к статистике выполнения.

## Использование

### SQL строкой, поток и повтор callback

В V7 класс `QueryClient` экспортируется из `@ydbjs/query`. Его методы запуска — `retrySession(options, callback)` и `retryTransaction(options, callback)`, либо `retrySession(callback)` и `retryTransaction(callback)` с настройками по умолчанию. Callback всегда передаётся последним. Также доступны `close()`, `destroy()` и structured disposal. Callback получает `(session, signal)` для текущей попытки. У корневого клиента нет методов `execute()`, `stream()`, `do()` и `transaction()`.

`session.execute()` принимает SQL строкой без изменений, именованные параметры и настройки запроса, накапливает ответ и возвращает `{ resultSets, stats, metadata }`. `session.stream()` возвращает части ответа. Если в базе не включены неявные типы параметров, объявляйте их через YQL `DECLARE`.

Прежний callable-тип называется `SQLClient`. `query(driver)` и `query(client)` предоставляют удобный теговый API с методами `sql.do()`, `sql.begin()` и `sql.transaction()`. `query(client)` использует тот же пул и жизненный цикл, что и переданный клиент.

`client.driver` возвращает драйвер, переданный в конструктор. За него отвечает вызывающий код. Закрывайте драйвер после всех клиентов, которые его используют.

`retrySession()` и `retryTransaction()` могут вызвать ваш callback несколько раз. Если всем попыткам нужен один и тот же ID заказа или результат расчёта эмбеддинга, получите его до вызова этих методов. Внутри каждой попытки собирайте объект параметров из этих значений.
Если callback читает изменяемый объект, при следующей попытке он увидит его текущее содержимое. Новый объект параметров может ссылаться на тот же `Buffer`. Если другой код может изменить буфер, сделайте копию через `Buffer.from(input)` перед вызовом `retrySession()` или `retryTransaction()` и используйте её во всех попытках.

Самостоятельный запрос с тегом `sql` один раз кодирует текст, настройки и параметры при первом запуске, до ожидания сессии. Автоматические повторы используют эти закрытые от вызывающего кода байты и добавляют текущий ID сессии. Повтор получает исходный текст, типы и значения, даже если вызывающий код изменил `Buffer`, содержимое `Value` или заменил параметр у объекта запроса. Внутри `sql.do()` и `sql.begin()` повторяется весь пользовательский callback, который может создать новый запрос.

```ts
import { QueryClient, query } from '@ydbjs/query'

type Row = { id: bigint }

await using client = new QueryClient(driver)

let text = 'SELECT $id AS id;'
let id = 42n
let signal = AbortSignal.timeout(30_000)

let result = await client.retrySession({ signal, idempotent: true }, (session) => {
  return session.execute<[Row]>(text, { id }, { timeout: 5000 })
})

let total = await client.retrySession(
  { signal, idempotent: true, retry: { budget: 3 } },
  async (session) => {
    let total = 0n

    for await (let part of session.stream<Row>(text, { id })) {
      for (let row of part.rows) {
        total += row.id
      }
    }

    return total
  }
)

let sql = query(client)

let [rows] = await sql<[Row]>`SELECT ${id} AS id`
```

Весь цикл чтения остаётся внутри retry callback. Поток сам не повторяет уже полученные строки: его ошибка передаётся ретраеру, который при допустимой ошибке повторяет callback целиком. Состояние обработки создаётся заново при каждом вызове callback. Внешние эффекты callback тоже могут повториться; `idempotent: false` не запрещает повтор после статуса с однозначно прерванной операцией. `retrySession()` закрепляет сессию за попыткой, но не объединяет запросы в атомарную операцию. Для группы записей, которые должны откатиться вместе, используйте `retryTransaction()`.

Настройки `retry`, `idempotent` и `onRetry` принадлежат callback; передача их в отдельный запрос отклоняется. Callback также задаёт общий `signal` и `timeout`. Второй аргумент callback — сигнал текущей попытки; передавайте его своему асинхронному коду, который должен прекращать работу при отмене попытки. Запрос может добавить свой `signal` или `timeout` в пределах оставшегося общего бюджета. Изоляция транзакции задаётся через настройки `retryTransaction()`; изоляция отдельного запроса доступна только внутри `retrySession()`.

```ts
let result = await client.retryTransaction(
  { signal, isolation: 'snapshotReadOnly', idempotent: true },
  (tx) => {
    return tx.execute<[Row]>(text, { id })
  }
)
```

Не дочитанный поток отклоняет callback и освобождает ресурсы. Ранний `break` отменяет RPC; для успешного завершения callback нужно дочитать поток. Сохранёнными executor и потоками нельзя пользоваться после завершения callback. Память потока зависит от размеров частей ответа, строк и числа параллельных операций, а не от полного размера результата. `responsePartLimitBytes` задаёт серверу целевой размер части, но не ограничивает JavaScript heap. `summary` доступен после успешного полного чтения. Отмена не доказывает, что запись не была выполнена сервером.

`beforeCommit()` вызывается перед RPC commit, в том числе для подготовки операций Topic. Старое имя `onCommit()` сохранено для совместимости. Ошибка `onClose()` после подтверждённого commit не запускает транзакцию заново. Аргумент `committed: false` означает отсутствие подтверждения commit, а не доказанный rollback при неизвестном исходе.

Ошибка cleanup после подтверждённого commit возвращается как `TransactionCompletionError` с `committed: true`; исходная ошибка доступна через `cause`. Такой результат не повторяется даже внешним SDK-ретраером. В V7 сравнение ошибки close-hook по идентичности нужно перенести на `cause`.

Отмена прекращает ожидание пользовательских hooks, даже если они игнорируют сигнал; RPC rollback получает отдельный ограниченный бюджет. Если commit уже подтверждён, отмена тоже возвращается через `TransactionCompletionError`. Остальные причины отмены сохраняются без изменения, кроме ошибок БД или сессии, допускающих повтор: они оборачиваются в `AbortError` с исходной причиной в `cause`, чтобы внешний ретраер не повторил отменённый callback.

Одна FSM на пул управляет приёмом операций, созданием и выдачей сессий, очередью и закрытием. Во временных объектах запросов FSM нет; контроллер отмены создаётся при запуске или явной отмене. Исход транзакции и границы повтора callback остаются в executor.

Выбор границ повтора и владения ресурсами разобран в [английском описании](README.md#ownership-and-retry-boundaries), со ссылками на другие SDK. [Демонстрация](../../examples/query-clients/src/demo.ts) использует raw-клиент и теговый API с общим пулом. [Измеритель памяти](../../examples/query-clients/src/memory.ts) читает поток внутри `retrySession()` и поддерживает результаты от 1 строки до 4 GiB, включая медленного потребителя; принудительный GC вызывается только после чтения. [Примеры запуска](README.md#examples) используют собранные файлы напрямую и локальную YDB; там же приведены ссылки на проверенные инварианты `ydbd`.

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

Тег `sql` подставляет в текст запроса имена параметров (`$p0`, `$p1`, …). Значение и тип YDB каждого параметра SDK передаёт отдельно от текста запроса. В V7 тег больше не добавляет `DECLARE`. В YDB 26.3.1.20 запросы с неявными типами параметров входят в [тесты Query Service](https://github.com/ydb-platform/ydb/blob/50df67c51b946ac2cd7f4f88d49f706cf8195116/ydb/core/kqp/ut/query/kqp_params_ut.cpp#L1196-L1228).

```ts
const userId = 42n
const userName = 'Alice'
await sql`
  SELECT * FROM users
  WHERE id = ${userId} AND name = ${userName}
`
```

#### Именованные параметры

Если имя параметра уже есть в тексте запроса, передайте значение по имени.

```ts
let id = 42n

await sql`SELECT $id AS id`.parameter('id', id)
```

Если в базе отключены неявные типы параметров, добавьте `DECLARE $id AS Int64;` перед `SELECT`. В YDB 26.3.1.20 объявление нужно для `Null`, `EmptyList`, `EmptyDict` и контейнеров с типом элемента `Null`, например `List<Null>`. Если тип элемента известен, передайте отсутствующее значение как `Optional<T>`, а пустой список как `List<T>` с конкретным типом `T`. [Пустые значения](../value/README.md#empty-values)

#### Как задать тип параметра явно

Для JavaScript-значения типа `bigint` SDK выбирает `Int64`. Если нужно передать беззнаковое число выше верхней границы `Int64`, укажите `Uint64` явно.

```ts
import { Uint64 } from '@ydbjs/value/primitive'

let id = new Uint64(2n ** 63n)

await sql`SELECT ${id} AS id`
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
await sql.begin({ isolation: 'snapshotReadOnly', idempotent: true }, async (tx) => {
  return await tx`SELECT COUNT(*) FROM users`
})
```

### Продвинутое: несколько наборов результатов, стриминг и события

```ts
import { StatsMode } from '@ydbjs/api/query'
// Несколько наборов результатов
type Result = [{ id: number }, { count: number }]
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

Внутри `sql.begin()` / `sql.transaction()` методы `isolation()` и `idempotent()` не переопределяют настройки транзакции. `timeout()` отдельного запроса продолжает действовать в пределах оставшегося общего времени, а `withStats()` запрашивает статистику этого запроса.

### Конвертация значений и безопасность типов

SDK преобразует значения JavaScript в параметры YDB. Например, обычный объект становится структурой `Struct`. [Соответствие типов](../value/README.md#infer-types-from-javascript)

```ts
let meta = { foo: 'bar' }

await sql`SELECT * FROM users WHERE meta = ${meta}`
```

Результаты с `Variant`, в том числе внутри контейнеров, доступны только в raw mode: `session.execute(text, parameters, { raw: true })` или `.raw()` у tagged SQL. Обычная конвертация отклоняет такие значения. Raw-ячейки сохраняют protobuf `Ydb.Value`, а наборы результатов `QueryClient` — схемы в `columns[].type`. SDK не предоставляет типизированные значения `Variant` и не определяет выбранную альтернативу по неоднозначным wire-данным.

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

При интерполяции и привязке по имени SDK передаёт значения отдельно от текста запроса. В JSON-объекте поля `type` и `encode` остаются обычными полями данных. Текст SQL, фрагменты для `unsafe()` и строковый разделитель для `join()` должны поступать из доверенного кода. Геттеры, прокси и пользовательские реализации `Value` могут выполнять код при преобразовании.

## Завершение клиента

`close()` запрещает запуск новых запросов и транзакций, ждёт завершения уже принятых операций и освобождает их сессии. Текущие операции могут закончить retry и commit. `await using` вызывает `close()`.

```ts
let sql = query(driver)
let statement = sql`SELECT 1 AS id`.execute()
await sql.close()
let result = await statement
```

`destroy()` немедленно отменяет запросы, транзакции и работу с сессиями, очищает пул и запрещает дальнейшее выполнение. `using` вызывает `destroy()`. Новые RPC rollback и DeleteSession при этом не отправляются: после отмены attach-стримов сессии очищает YDB. Уже запущенный пользовательский callback получает отменённый сигнал; его собственный асинхронный код должен учитывать этот сигнал.

```ts
using sql = query(driver)
let statement = sql`SELECT 1 AS id`
let result = statement.then(
  (rows) => rows,
  (error) => error
)
sql.destroy()
await result
```

Переданный `Driver` остаётся открытым, поэтому остальные клиенты могут продолжать его использовать. Чтобы очистить параметры, сохранённый результат и подписки отдельного запроса, вызовите `statement.destroy()` или `await statement.dispose()`. Метод `cancel()` только отменяет выполнение и публикует прежнее событие `cancel`.

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
