---
title: Query — Types and Values
---

# Working with YDB Types and Values

`@ydbjs/value` provides type-safe conversion between JS and YDB:

- fromJs(js) — converts a JS value into a typed YDB value (type inference).
- toJs(ydb) — converts a YDB value back into native JS.
- Exposes type/value classes: Struct, List, Tuple, Dict, Optional, Null, primitives, etc.

## Quick start

```ts
import { fromJs } from '@ydbjs/value'
await sql`INSERT INTO users SELECT * FROM AS_TABLE(${[{ id: 1, name: 'Alice' }]})`

// Explicit wrapper (usually not required):
await sql`SELECT * FROM users WHERE meta = ${fromJs({ enabled: true })}`
```

Interpolations inside sql`...` call fromJs automatically; explicit usage is rarely needed, mostly for strict typing control.

## Optional (nullable)

In YDB, nullable fields are represented by `Optional<T>`. In JS this is `null`.

```ts
import { Optional } from '@ydbjs/value'

// DON'T: pass bare null — YDB can't infer Optional<T> from JS null
// await sql`SELECT * FROM users WHERE middle_name = ${null}` // avoid this

// DO: wrap value with Optional carrying the explicit element type
// Example: middle_name has type Optional<Text>
import { Optional } from '@ydbjs/value'
import { TextType } from '@ydbjs/value/primitive'
await sql`SELECT * FROM users WHERE middle_name = ${new Optional(null, new TextType())}`

// Explicit Optional when you need to control field type:
await sql`SELECT * FROM users WHERE age = ${Optional.int32(null)}`
```

When generating table parameters from an array of objects, missing fields automatically become Optional in the resulting Struct.

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
import { List, Struct, Optional } from '@ydbjs/value'
import { Int32Type, TextType } from '@ydbjs/value/primitive'

// Struct<{ id: Int32; name: Optional<Text> }>
const userType = new Struct({
  id: new Int32Type(),
  name: new Optional(null, new TextType()).type, // type only; set value separately
})

// List<Struct<...>> with values
const users = new List(
  new Struct({ id: 1, name: new Optional(null, new TextType()) }, userType.type),
  new Struct({ id: 2, name: new Optional('Bob', new TextType()) }, userType.type)
)

await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`
```

## Primitives and special types

```ts
import { Uint64, Timestamp, Json } from '@ydbjs/value/primitive'

await sql`INSERT INTO t(id, ts, meta) VALUES (${new Uint64(1n)}, ${new Timestamp(new Date())}, ${new Json('{"foo":1}')})`
```

Native JS types (number, string, boolean, Date) with fromJs are typically enough; special classes help enforce format/range.

## fromJs and toJs

```ts
import { fromJs, toJs } from '@ydbjs/value'

const ydbVal = fromJs({ a: 1, b: [true, false] })
console.log(toJs(ydbVal)) // { a: 1, b: [true, false] }
```

## Printing types (debug)

```ts
import { typeToString } from '@ydbjs/value/print'
const q = sql`SELECT 1 AS a`
await q
console.log(typeToString(q.stats()?.resultSets?.[0]?.columns?.[0]?.type!))
```

## Recommendations

- Use native JS values for parameters — the SDK wraps them into YDB Value.
- For complex structures pass plain objects/arrays — fromJs will build the type automatically.
- For nullable fields `null` is fine; use explicit Optional when strict control is needed.
- Avoid mixing heterogeneous types within a single array, except for union-like struct merges (fields become Optional).
