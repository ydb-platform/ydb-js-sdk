---
title: Query — типы и @ydbjs/value
---

# Работа с типами YDB и пакетом @ydbjs/value

@ydbjs/value отвечает за типобезопасную конвертацию значений между JS и YDB:

- fromJs(js) — конвертирует JS‑значение в типизированное YDB‑значение (инференс типа).
- toJs(ydb) — преобразует YDB‑значение обратно в нативный JS.
- Экспортирует классы типов и значений: Struct, List, Tuple, Dict, Optional, Null, примитивы и др.

## Быстрый старт

```ts
import { fromJs } from '@ydbjs/value'
await sql`INSERT INTO users SELECT * FROM AS_TABLE(${[{ id: 1, name: 'Alice' }]})`

// Явная обёртка (обычно не требуется):
await sql`SELECT * FROM users WHERE meta = ${fromJs({ enabled: true })}`
```

Интерполяции в sql`...` автоматически вызывают fromJs, поэтому явное использование нужно редко — в основном для контроля типа.

## Optional (nullable)

В YDB nullable поля представлены типом `Optional<T>`. В JS это `null`.

```ts
import { Optional } from '@ydbjs/value'

// НЕЛЬЗЯ: передавать null без явного типа — из JS null невозможно понять YDB‑тип Optional над каким именно T
// await sql`SELECT * FROM users WHERE middle_name = ${null}` // так делать не нужно

// Делайте так: указывайте тип явно, оборачивая значение в Optional с явным типом
// Пример: middle_name имеет тип Optional<Text>
import { Optional } from '@ydbjs/value'
import { TextType } from '@ydbjs/value/primitive'
await sql`SELECT * FROM users WHERE middle_name = ${new Optional(null, new TextType())}`

// Явный Optional, если нужно управлять типом поля:
await sql`SELECT * FROM users WHERE age = ${Optional.int32(null)}`
```

При генерации табличных параметров из массива объектов отсутствующие поля автоматически становятся Optional в результирующем Struct.

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
import { List, Struct, Optional } from '@ydbjs/value'
import { Int32Type, TextType } from '@ydbjs/value/primitive'

// Struct<{ id: Int32; name: Optional<Text> }>
const userType = new Struct({
  id: new Int32Type(),
  name: new Optional(null, new TextType()).type, // только тип, значение зададим отдельно
})

// List<Struct<...>> со значениями
const users = new List(
  new Struct({ id: 1, name: new Optional(null, new TextType()) }, userType.type),
  new Struct({ id: 2, name: new Optional('Bob', new TextType()) }, userType.type),
)

await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`
```

## Примитивы и специальные типы

```ts
import { Uint64, Timestamp, Json } from '@ydbjs/value/primitive'

await sql`INSERT INTO t(id, ts, meta) VALUES (${new Uint64(1n)}, ${new Timestamp(new Date())}, ${new Json('{"foo":1}')})`
```

Обычно достаточно нативных JS типов (number, string, boolean, Date) и fromJs — он корректно выведет типы. Специальные классы пригодятся для явного контроля формата/диапазона.

## fromJs и toJs

```ts
import { fromJs, toJs } from '@ydbjs/value'

const ydbVal = fromJs({ a: 1, b: [true, false] })
console.log(toJs(ydbVal)) // { a: 1, b: [true, false] }
```

## Печать типов (debug)

```ts
import { typeToString } from '@ydbjs/value/print'
const q = sql`SELECT 1 AS a`
await q
console.log(typeToString(q.stats()?.resultSets?.[0]?.columns?.[0]?.type!))
```

## Рекомендации

- Для параметров используйте нативные JS значения — SDK сам обернёт их в YDB Value.
- Для сложных структур передавайте plain объекты/массивы — fromJs построит тип автоматически.
- Для nullable полей достаточно null; явный Optional используйте при жёстком контроле типа.
- Избегайте смешения гетерогенных типов в одном массиве, кроме ожидаемого кейса объединения структур (поля станут Optional).
