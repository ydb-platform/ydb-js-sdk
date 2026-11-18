---
title: Query — типы и @ydbjs/value
---

# Работа с типами YDB и пакетом @ydbjs/value

`@ydbjs/value` преобразует значения между JavaScript и YDB:

- fromJs(js) — конвертирует JS‑значение в типизированное YDB‑значение (инференс типа).
- toJs(ydb) — преобразует YDB‑значение обратно в нативный JS.
- Корень пакета экспортирует функции преобразования и интерфейсы `Type` и `Value`; конструкторы доступны в подпутях, например `@ydbjs/value/optional` и `@ydbjs/value/struct`.

## Быстрый старт

```ts
import { fromJs } from '@ydbjs/value'

await sql`INSERT INTO users SELECT * FROM AS_TABLE(${[{ id: 1, name: 'Alice' }]})`

// Явная обёртка (обычно не требуется):
await sql`SELECT * FROM users WHERE meta = ${fromJs({ enabled: true })}`
```

Интерполяции в sql`...` автоматически вызывают `fromJs`. Явный вызов использует те же правила вывода типов; для конкретного типа YDB нужны конструкторы Value.

## Optional (nullable)

В YDB nullable-поля представлены типом `Optional<T>`. Отсутствующий Optional преобразуется в JavaScript `null`, но `fromJs(null)` создаёт отдельный тип `Null` и не может определить `T`.

```ts
import { Optional } from '@ydbjs/value/optional'
import { Int32, Int32Type, TextType } from '@ydbjs/value/primitive'

let middleName = new Optional(null, new TextType())
let absentAge = new Optional(null, new Int32Type())
let age = new Optional(new Int32(42))

await sql`SELECT ${middleName} AS middle_name, ${absentAge} AS absent_age, ${age} AS age`
```

Шаблон отклоняет интерполяции с обычными `null` и `undefined`. Именованные привязки `.parameter()` и объект параметров SQL-клиента принимают `null` как YDB `Null`, для которого может понадобиться `DECLARE`; это не отсутствующий Optional с известным типом. Для проверки отсутствия значения в колонке используйте `IS NULL`, а не сравнение с отсутствующим Optional.

При преобразовании массива объектов все поля становятся Optional, а пропущенные поля — отсутствующими значениями. Явный `null` не получает тип поля из другой строки: `fromJs([{ age: null }, { age: 42 }])` отклоняет несовместимые типы.

## Контейнерные типы

- Optional — обёртка для nullable‑значения с явным типом элемента.
- List — список элементов одного типа.
- Tuple — позиционный кортеж фиксированной длины.
- Dict — словарь ключ→значение с типами для ключа и значения.

Типы и значения задаются через классы `Optional`, `List`, `Tuple`, `Dict` и соответствующие `*Type`. В большинстве случаев тип выводится автоматически через `fromJs`.

```ts
// List<Struct>
await sql`INSERT INTO events SELECT * FROM AS_TABLE(${[
  { id: 1, payload: { ok: true } },
  { id: 2, payload: { ok: false } },
]})`

// Tuple, Dict — создаются через fromJs при необходимости
```

Явное построение типов (когда нужен точный контроль):

```ts
import { List, ListType } from '@ydbjs/value/list'
import { Optional, OptionalType } from '@ydbjs/value/optional'
import { Int32, Int32Type, Text, TextType } from '@ydbjs/value/primitive'
import { Struct, StructType } from '@ydbjs/value/struct'

let userType = new StructType(['id', 'name'], [new Int32Type(), new OptionalType(new TextType())])

let users = new List(
  [
    new Struct({ id: new Int32(1) }, userType),
    new Struct({ id: new Int32(2), name: new Optional(new Text('Bob')) }, userType),
  ],
  new ListType(userType)
)

await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`
```

`StructType` описывает схему полей, а `Struct` содержит объекты Value. При явной схеме пропущенные Optional-поля становятся отсутствующими значениями. Явный `ListType` сохраняет тип элемента даже для пустого списка. Поля без Optional нужны, например, для табличных параметров с колонками `NOT NULL`.

## Примитивы и специальные типы

```ts
import { Uint64, Timestamp, Json } from '@ydbjs/value/primitive'

await sql`INSERT INTO t(id, ts, meta) VALUES (${new Uint64(1n)}, ${new Timestamp(new Date())}, ${new Json('{"foo":1}')})`
```

Обычно достаточно нативных JS типов (number, string, boolean, Date) и fromJs — он корректно выведет типы. Специальные классы пригодятся для явного контроля формата/диапазона.

Результаты `Variant` и PostgreSQL, в том числе во вложенных схемах, требуют raw mode: `session.execute(text, parameters, { raw: true })` или `.raw()` у тегового запроса. Обычное преобразование отклоняет такие схемы даже внутри отсутствующих Optional и пустых контейнеров. Raw-ячейка содержит protobuf `Ydb.Value`, а `QueryClient` сохраняет схему в `columns[].type`. Сама ячейка не служит SDK Value или полным типизированным параметром.

## fromJs и toJs

```ts
import { fromJs, toJs } from '@ydbjs/value'

let ydbVal = fromJs({ a: 1, b: [true, false] })
console.log(toJs(ydbVal)) // { a: 1, b: [true, false] }
```

Декодированные Struct и строки запросов в объектном режиме имеют нулевой прототип. Проверяйте наличие полей через `Object.hasOwn(record, name)`; унаследованных методов вроде `record.hasOwnProperty()` у них нет.

`fromYdb(wireValue, wireType)` восстанавливает SDK Value со схемой. `toJs(value)` преобразует его в JavaScript и может терять различия, например уровни вложенных Optional или микросекунды Timestamp. По умолчанию типы с часовым поясом и расширенные типы даты и времени остаются SDK Values. Для результатов Temporal задайте `temporal: true` при создании клиента; приложение должно предоставить `globalThis.Temporal`. TzDate и TzDate32 остаются Values и в этом режиме. См. [полные правила преобразования](https://github.com/ydb-platform/ydb-js-sdk/tree/main/packages/value#read-results).

## Печать типов (debug)

```ts
import { fromJs } from '@ydbjs/value'
import { typeToString } from '@ydbjs/value/print'

let value = fromJs({ id: 42, name: 'Alice' })

console.log(typeToString(value.type)) // Struct<id:Int32,name:Utf8>
```

## Рекомендации

- Для параметров используйте нативные JS значения — SDK сам обернёт их в YDB Value.
- Для сложных структур передавайте plain объекты/массивы — fromJs построит тип автоматически.
- Для отсутствующего значения с известным типом YDB используйте `new Optional(null, itemType)`.
- Избегайте смешения гетерогенных типов в одном массиве, кроме ожидаемого кейса объединения структур (поля станут Optional).
