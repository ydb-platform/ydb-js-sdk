---
title: Query — Types and Values
---

# Working with YDB Types and Values

`@ydbjs/value` provides type-safe conversion between JS and YDB:

- fromJs(js) — converts a JS value into a typed YDB value (type inference).
- toJs(ydb) — converts a YDB value back into native JS.
- The package root exports conversion functions and the `Type` and `Value` interfaces; constructors are exported from subpaths such as `@ydbjs/value/optional` and `@ydbjs/value/struct`.

## Quick start

```ts
import { fromJs } from '@ydbjs/value'

await sql`INSERT INTO users SELECT * FROM AS_TABLE(${[{ id: 1, name: 'Alice' }]})`

// Explicit wrapper (usually not required):
await sql`SELECT * FROM users WHERE meta = ${fromJs({ enabled: true })}`
```

Interpolations inside sql`...` call `fromJs` automatically. Calling it explicitly uses the same inference rules; use Value constructors when the query requires a specific YDB type.

## Optional (nullable)

In YDB, nullable fields are represented by `Optional<T>`. An absent Optional becomes `null` when converted to JavaScript, but `fromJs(null)` produces the separate `Null` type and cannot infer `T`.

```ts
import { Optional } from '@ydbjs/value/optional'
import { Int32, Int32Type, TextType } from '@ydbjs/value/primitive'

let middleName = new Optional(null, new TextType())
let absentAge = new Optional(null, new Int32Type())
let age = new Optional(new Int32(42))

await sql`SELECT ${middleName} AS middle_name, ${absentAge} AS absent_age, ${age} AS age`
```

The tagged template rejects bare `null` and `undefined` interpolations. Named `.parameter()` bindings and plain-SQL parameter objects accept `null` as YDB `Null`, which may require an explicit `DECLARE`; it is not a typed absent Optional. Use `IS NULL` to test a nullable database column for absence rather than comparing it to an absent Optional.

When generating table parameters from an array of objects, every field becomes Optional and missing fields become absent values. Explicit `null` does not acquire the type of another row's field: `fromJs([{ age: null }, { age: 42 }])` rejects the incompatible types.

## Container types

- Optional — wrapper for nullable value with explicit element type.
- List — list of elements of the same type.
- Tuple — positional fixed-length tuple.
- Dict — key→value dictionary with explicit key/value types.

Types/values are built via `Optional`, `List`, `Tuple`, `Dict` and corresponding `*Type` classes. Most types are inferred via `fromJs`.

```ts
// List<Struct>
await sql`INSERT INTO events SELECT * FROM AS_TABLE(${[
  { id: 1, payload: { ok: true } },
  { id: 2, payload: { ok: false } },
]})`

// Tuple, Dict — use fromJs when needed
```

Explicit type construction (when strict control is required):

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

`StructType` describes field schemas; `Struct` contains Value objects. With an explicit schema, omitted Optional fields become absent values. An explicit `ListType` also preserves the element schema when the list is empty. Explicit non-Optional fields are useful for table parameters targeting `NOT NULL` columns.

## Primitives and special types

```ts
import { Uint64, Timestamp, Json } from '@ydbjs/value/primitive'

await sql`INSERT INTO t(id, ts, meta) VALUES (${new Uint64(1n)}, ${new Timestamp(new Date())}, ${new Json('{"foo":1}')})`
```

Native JS types (number, string, boolean, Date) with fromJs are typically enough; special classes help enforce format/range.

`Variant` and PostgreSQL results, including nested schemas, require raw mode: `session.execute(text, parameters, { raw: true })` or `.raw()` on a tagged query. Ordinary result conversion rejects them even inside absent Optionals or empty containers. Raw cells preserve the protobuf `Ydb.Value`; `QueryClient` result-set `columns[].type` preserves the schema. A raw cell is not an SDK Value or a complete typed parameter.

## fromJs and toJs

```ts
import { fromJs, toJs } from '@ydbjs/value'

let ydbVal = fromJs({ a: 1, b: [true, false] })
console.log(toJs(ydbVal)) // { a: 1, b: [true, false] }
```

Decoded Structs and object-mode query rows have a null prototype. Use `Object.hasOwn(record, name)` to check fields; inherited methods such as `record.hasOwnProperty()` are unavailable.

`fromYdb(wireValue, wireType)` reconstructs an SDK Value, preserving its schema. `toJs(value)` projects it to JavaScript and can lose distinctions such as nested Optional presence or Timestamp microseconds. By default, timezone types and extended date/time types remain SDK Values. Enable `temporal: true` when creating a query client for Temporal results; the application must supply `globalThis.Temporal`. TzDate and TzDate32 remain Values even in that mode. See [the complete conversion rules](https://github.com/ydb-platform/ydb-js-sdk/tree/main/packages/value#read-results).

## Printing types (debug)

```ts
import { fromJs } from '@ydbjs/value'
import { typeToString } from '@ydbjs/value/print'

let value = fromJs({ id: 42, name: 'Alice' })

console.log(typeToString(value.type)) // Struct<id:Int32,name:Utf8>
```

## Recommendations

- Use native JS values for parameters — the SDK wraps them into YDB Value.
- For complex structures pass plain objects/arrays — fromJs will build the type automatically.
- Use `new Optional(null, itemType)` for an absent value with a known YDB type.
- Avoid mixing heterogeneous types within a single array, except for union-like struct merges (fields become Optional).
