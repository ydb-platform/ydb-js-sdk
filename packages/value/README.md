# @ydbjs/value

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=value)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/packages/value/)

Create typed YDB parameters and read YDB results in JavaScript and TypeScript.
`Type` describes the schema; `Value` holds data with that schema.
Treat these objects and the protobuf returned by `encode()` as read-only: editing their fields, arrays, or encoded messages is unsupported.

## Installation

```sh
npm install @ydbjs/value
```

## Create parameters

Use `fromJs` when the type can be inferred from the input:

```ts
import { fromJs } from '@ydbjs/value'

let parameter = fromJs({ id: 42, name: 'Alice' })
let wireType = parameter.type.encode()
let wireValue = parameter.encode()
```

The two encoded objects form the parameter's schema and value; send them together.
Use explicit constructors when the query requires a particular schema:

```ts
import { Int64, Int32Type } from '@ydbjs/value/primitive'
import { Optional } from '@ydbjs/value/optional'

let id = new Int64(42n)
let absentCount = new Optional(null, new Int32Type())
```

Value and type classes are exported from their subpaths: `@ydbjs/value/primitive`, `/optional`, `/list`, `/dict`, `/tuple`, `/struct`, `/null`, `/decimal`, `/empty`, `/variant`, `/tagged`, `/void`, and `/pg`.
The package root exports the conversion functions and the `Type` and `Value` interfaces.

### Explicit container types

Lists require one element schema; dictionaries require one key schema and one value schema.
Constructors reject incompatible types, including differences in nested types and Struct member names or positions.
Pass a type explicitly to preserve the schema of an empty container:

```ts
import { Dict, DictType } from '@ydbjs/value/dict'
import { List, ListType } from '@ydbjs/value/list'
import { Int32, Int32Type, TextType } from '@ydbjs/value/primitive'

let numbers = new List(new Int32(1), new Int32(2))
let emptyNumbers = new List([], new ListType(new Int32Type()))
let emptyLookup = new Dict([], new DictType(new TextType(), new Int32Type()))
```

Without an explicit type, `new List()` uses `List<Null>` and `new Dict()` uses `Dict<Null,Null>`.
For structs, `new Struct(fields, structType)` uses the supplied field schema and fills missing Optional fields with absent values.

### Decimal

Use a string for an exact decimal number and a `DecimalType` for its precision and scale:

```ts
import { Decimal, DecimalType } from '@ydbjs/value/decimal'

let type = new DecimalType(22, 9)
let amount = new Decimal('123.456000001', type)
let sameAmount = new Decimal(123456000001n, type)
```

A bigint is the already scaled integer: `123n` with scale 2 means `1.23`.
String input accepts plain decimal notation and `inf`, `-inf`, `nan`; it rejects exponents, overflow and values that would require rounding.
Trailing fractional zeros beyond the declared scale are accepted because they do not change the value.
JavaScript numbers are rejected to avoid precision loss before construction.

### Empty values and variants

```ts
import { EmptyList, EmptyDict } from '@ydbjs/value/empty'
import { Int32, Int32Type, TextType } from '@ydbjs/value/primitive'
import { StructType } from '@ydbjs/value/struct'
import { Variant, VariantType } from '@ydbjs/value/variant'
import { Void } from '@ydbjs/value/void'

let emptyList = new EmptyList()
let emptyDict = new EmptyDict()
let nothing = new Void()
let alternatives = new VariantType(
  new StructType(['count', 'text'], [new Int32Type(), new TextType()])
)
let choice = new Variant(new Int32(42), 'count', alternatives)
```

EmptyList and EmptyDict are distinct protocol types; typed empty List/Dict constructors retain their element schemas instead.
A Variant over `TupleType` selects an alternative by its numeric index; a Variant over `StructType` selects by field name.
The selected value must match that alternative's complete schema.
The server does not accept absent `Optional<Variant<...>>` parameters; Query rejects these values before sending ExecuteQuery, including inside containers.
Construct the absence in YQL instead of binding it as a parameter.
Read the selected value through `.item`, its selector through `.tag`, and its wire index through `.index`.

### Temporal values

The package supports all 32 primitive types exported by ydbd, including TzDate32, TzDatetime64 and TzTimestamp64.
The three extended timezone IDs (68, 69 and 70) are named by `ExtendedPrimitiveTypeId` in the primitive subpath because the public protobuf enum does not name them; [ydbd exports them as numeric IDs](https://github.com/ydb-platform/ydb/blob/c8849250fc4a4d453b0188f89560f298587ef5cf/ydb/library/mkql_proto/mkql_proto.cpp#L854).
Date32, Datetime64, Timestamp64, Interval64 and DyNumber also have named constructors and corresponding Type classes.

| Constructors                                                    | Accepted input                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| Date, Date32                                                    | JavaScript `Date`, or integer days since the Unix epoch        |
| Datetime                                                        | JavaScript `Date`, or integer seconds since the Unix epoch     |
| Datetime64                                                      | JavaScript `Date`, or bigint seconds since the Unix epoch      |
| Timestamp, Timestamp64                                          | JavaScript `Date`, or bigint microseconds since the Unix epoch |
| Interval                                                        | Safe integer number of microseconds                            |
| Interval64                                                      | Bigint microseconds, or a safe integer number                  |
| TzDate, TzDatetime, TzTimestamp and their extended counterparts | `TZDate`, or exact YDB date/time text followed by a timezone   |
| DyNumber                                                        | Decimal text as a string                                       |

```ts
import { Timestamp64, TzTimestamp64 } from '@ydbjs/value/primitive'

let timestamp = new Timestamp64(-1n)
let zoned = new TzTimestamp64('-1-02-29T12:34:56.123456,UTC')
```

Exact units and timezone strings preserve precision that JavaScript Date cannot represent.
Constructors check numeric temporal ranges and timezone calendar fields; timestamps are not rounded to fit the declared type.
YDB historical years have no year zero: `-1` maps to JavaScript astronomical year `0`.
Timezone text carries no DST fold indicator, and the server resolves ambiguous local times using its earlier occurrence; the protocol cannot distinguish both occurrences of a repeated wall-clock time.

### PostgreSQL values

```ts
import { Pg, PgType } from '@ydbjs/value/pg'

let integer = new Pg('42', new PgType('int4'))
let absentInteger = new Pg(null, new PgType('int4'))
let byOid = new Pg('42', new PgType({ oid: 23 }))
```

Pg keeps text, binary bytes or null in `.value` and preserves its type name, OID and modifiers in `.type`.
It does not guess a JavaScript representation from PostgreSQL text or binary data.
The string PgType constructor normalizes names such as `int4` and `_int4` to YQL names `pgint4` and `_pgint4`.
OID-only descriptors can be bound with QueryClient and an explicit SQL declaration such as `DECLARE $value AS pgint4;`; automatic tagged-SQL declarations require a type name.

### Tagged results

`Tagged(item, tag)` and `TaggedType(tag, itemType)` preserve semantic tags and the underlying typed value.
The tag is available through `.type.tag`, and the wrapped value through `.item`.
YDB exports Tagged results but does not accept Tagged query parameter types.
QueryClient and the tagged-SQL API reject Tagged anywhere in a parameter schema before sending ExecuteQuery; pass the inner value and apply `AsTagged` in the query when needed.

## Infer types from JavaScript

| JavaScript input                   | Inferred YDB type              | Notes                                                         |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `boolean`                          | Bool                           |                                                               |
| Integer `number`                   | Int32                          | Use an explicit integer type when the required schema differs |
| Non-integer `number`               | Double                         |                                                               |
| `bigint`                           | Int64                          |                                                               |
| `string`                           | Utf8                           |                                                               |
| `Date`                             | Datetime                       | Second precision; use `Timestamp` explicitly for milliseconds |
| `TZDate`                           | TzDatetime                     | From `@date-fns/tz`                                           |
| `Uint8Array`                       | String                         | Binary data                                                   |
| `Float32Array` / `Float64Array`    | `List<Float>` / `List<Double>` |                                                               |
| `BigInt64Array` / `BigUint64Array` | `List<Int64>` / `List<Uint64>` |                                                               |
| `null`                             | Null                           | Does not infer an Optional item type                          |
| `Array`                            | List                           | Elements must have compatible types                           |
| `Set`                              | Tuple                          | Elements may have different types                             |
| `Map`                              | Dict                           | Keys and values are converted recursively                     |
| Plain object                       | Struct                         | Own enumerable fields are converted recursively               |

```ts
import { fromJs, toJs } from '@ydbjs/value'

let list = fromJs([1, 2, 3])
let tuple = fromJs(new Set([42, 'foo']))
let dict = fromJs(
  new Map([
    ['a', 1],
    ['b', 2],
  ])
)
let struct = fromJs({ id: 123, name: 'Alice' })

toJs(list) // [1, 2, 3]
toJs(tuple) // [42, 'foo']
toJs(dict) // Map { 'a' => 1, 'b' => 2 }
toJs(struct) // { id: 123, name: 'Alice' }
```

### Arrays of records

For an array of plain objects, `fromJs` builds a shared Struct schema from the union of fields and wraps every field in Optional.
Missing fields become absent Optionals:

```ts
import { fromJs, toJs } from '@ydbjs/value'

let rows = fromJs([
  { id: 1, name: 'Alice' },
  { id: 2, age: 30 },
])

toJs(rows)
// [{ age: null, id: 1, name: 'Alice' }, { age: 30, id: 2, name: null }]
```

Fields with the same name must have compatible types, including their nested schemas.
`fromJs([{ x: { a: 1 } }, { x: { b: 2 } }])` throws instead of reinterpreting `b` as `a`.
Explicit `null` has type Null, so `fromJs([{ x: null }, { x: 1 }])` also throws; use typed Optionals to express nullable integers:

```ts
import { List } from '@ydbjs/value/list'
import { Optional } from '@ydbjs/value/optional'
import { Int32, Int32Type } from '@ydbjs/value/primitive'
import { Struct } from '@ydbjs/value/struct'

let rows = new List(
  new Struct({ x: new Optional(null, new Int32Type()) }),
  new Struct({ x: new Optional(new Int32(1)) })
)
```

Because inferred record arrays use Optional fields, their schema does not match `NOT NULL` columns.
Construct non-nullable rows explicitly, or reuse a `StructType` with `new Struct(fields, type)`:

```ts
import { List } from '@ydbjs/value/list'
import { Bytes, Text, Uint8 } from '@ydbjs/value/primitive'
import { Struct } from '@ydbjs/value/struct'

let rows = new List(
  new Struct({
    key: new Text('a'),
    partNumber: new Uint8(0),
    data: new Bytes(new Uint8Array([1, 2])),
  })
)
```

## Read results

`fromYdb(wireValue, wireType)` reconstructs a typed Value from a protobuf value and its schema.
It restores the supplied schema, including empty containers, absent Optionals, nested Optional presence, Variant alternatives, Tagged values, Void and PostgreSQL metadata.
For an unambiguous wire representation, re-encoding produces a semantically equivalent type/value pair.
If the server encoding cannot identify a unique Optional/Variant nesting, typed decoding throws with guidance to use raw query results or select an explicit representation in YQL.

```ts
import { fromYdb, toJs } from '@ydbjs/value'
import { Optional } from '@ydbjs/value/optional'
import { Int32Type } from '@ydbjs/value/primitive'
import { typeToString } from '@ydbjs/value/print'

let input = new Optional(new Optional(null, new Int32Type()))
let result = fromYdb(input.encode(), input.type.encode())

typeToString(result.type) // 'Optional<Optional<Int32>>'
toJs(result) // null
```

`toJs(value)` projects a typed Value into JavaScript data.
This projection can lose information: different Optional levels become `null`, Lists and Tuples become arrays, and timestamps lose sub-millisecond precision.
Use the typed Value when that distinction matters.
Variant, Tagged, Pg and Void have no automatic native projection: `toJs` returns the SDK Value unchanged, retaining its schema and typed fields.
This rule also applies recursively to those values inside arrays, structs, maps and Optionals.

| YDB type                                                               | JavaScript result                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Bool                                                                   | `boolean`                                                   |
| Int8/16/32, Uint8/16/32, Float, Double                                 | `number`                                                    |
| Int64, Uint64                                                          | `bigint`                                                    |
| Utf8, Uuid, DyNumber, Decimal                                          | `string`                                                    |
| String, Yson                                                           | `Uint8Array`                                                |
| Json, JsonDocument                                                     | Parsed JavaScript value                                     |
| Date, Date32, Datetime, Datetime64, Timestamp, Timestamp64             | `Date` with millisecond precision                           |
| TzDate, TzDatetime, TzTimestamp, TzDate32, TzDatetime64, TzTimestamp64 | `TZDate` with millisecond precision in the encoded timezone |
| Interval                                                               | `number` of microseconds                                    |
| Interval64                                                             | `bigint` of microseconds                                    |
| Optional                                                               | Inner projection, or `null` when absent                     |
| List, Tuple, EmptyList                                                 | Array                                                       |
| Dict, EmptyDict                                                        | `Map`                                                       |
| Struct                                                                 | Object with own data properties                             |
| Null                                                                   | `null`                                                      |
| Variant, Tagged, Pg, Void                                              | The same SDK Value                                          |

Decimal and DyNumber results remain strings to preserve numeric precision.
`Interval` accepts safe integer numbers of microseconds; the supported YDB Interval range fits exactly in a JavaScript number.

### Ambiguous server values

Some server encodings of Optional around Variant reuse the same nested-value wrapper for different meanings.
When more than one distinct typed interpretation is possible, `fromYdb` throws rather than assigning an alternative or Optional presence.
Ordinary Query decoding reports the same error.
Use raw results to inspect the protobuf, or change the YQL projection to return an explicit alternative and its tag.

QueryClient exposes raw cells together with their column schemas:

```ts
let result = await client.retrySession((session) => session.execute(queryText, {}, { raw: true }))
let { columns, rows } = result.resultSets[0]!
```

The tagged-SQL API also provides `.raw()` for protobuf cells; use QueryClient when column types are needed alongside those cells.
A raw cell alone is not a typed parameter: preserve its column schema when inspecting it, and construct a supported, explicit Value before binding.

## Development

```sh
npm run build
npm test
```

## License

[Apache 2.0](../../LICENSE)

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
