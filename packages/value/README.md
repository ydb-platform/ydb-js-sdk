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

Value and type classes are exported from their subpaths: `@ydbjs/value/primitive`, `/optional`, `/list`, `/dict`, `/tuple`, `/struct`, `/null`, `/decimal`, `/empty`, `/tagged`, `/void`, and `/pg`.
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

### Empty values

```ts
import { EmptyList, EmptyDict } from '@ydbjs/value/empty'
import { Void } from '@ydbjs/value/void'

let emptyList = new EmptyList()
let emptyDict = new EmptyDict()
let nothing = new Void()
```

EmptyList and EmptyDict are distinct protocol types; typed empty List/Dict constructors retain their element schemas instead.

### Temporal values

The package supports all 32 primitive types exported by ydbd, including TzDate32, TzDatetime64 and TzTimestamp64.
The three extended timezone IDs (68, 69 and 70) are named by `ExtendedPrimitiveTypeId` in the primitive subpath because the public protobuf enum does not name them; [ydbd exports them as numeric IDs](https://github.com/ydb-platform/ydb/blob/c8849250fc4a4d453b0188f89560f298587ef5cf/ydb/library/mkql_proto/mkql_proto.cpp#L854).
Date32, Datetime64, Timestamp64, Interval64 and DyNumber also have named constructors and corresponding Type classes.

| Constructors                                                    | Accepted input                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Date, Date32                                                    | JavaScript `Date`, `Temporal.PlainDate`, or integer days since the Unix epoch      |
| Datetime                                                        | JavaScript `Date`, `Temporal.Instant`, or integer seconds since the Unix epoch     |
| Datetime64                                                      | JavaScript `Date`, `Temporal.Instant`, or bigint seconds since the Unix epoch      |
| Timestamp, Timestamp64                                          | JavaScript `Date`, `Temporal.Instant`, or bigint microseconds since the Unix epoch |
| Interval                                                        | `Temporal.Duration`, or a safe integer number of microseconds                      |
| Interval64                                                      | `Temporal.Duration`, bigint microseconds, or a safe integer number of microseconds |
| TzDate, TzDatetime, TzTimestamp and their extended counterparts | `Temporal.ZonedDateTime`, or YDB date/time text followed by an IANA timezone       |
| DyNumber                                                        | Decimal text as a string                                                           |

Timezone constructors require a global Temporal implementation, including when validating string input; see [Temporal setup](#temporal-setup).

```ts
import { Timestamp64, TzTimestamp64 } from '@ydbjs/value/primitive'

let timestamp = new Timestamp64(-1n)
let zoned = new TzTimestamp64('-1-02-29T12:34:56.123456,UTC')
```

Exact units and timezone strings preserve precision that JavaScript `Date` cannot represent.
Constructors check YDB ranges and reject Temporal inputs with precision finer than the target type: Datetime requires whole seconds, while Timestamp and Interval require whole microseconds, including their extended counterparts.
JavaScript `Date` input retains its existing conversion: Date uses the UTC calendar day and Datetime rounds down to whole seconds.
Temporal date and timezone inputs must use the `iso8601` calendar; durations must contain only time units, with no years, months, weeks or days.
YDB historical years have no year zero: `-1` in timezone text maps to Temporal astronomical year `0`.
Timezone constructors and Temporal result conversion reject nonexistent or repeated local times at timezone transitions because the wire text carries neither an offset nor a DST fold indicator.
Timezone validation uses the runtime's timezone database; the server must also recognize the zone and its rules.
TzDate and TzDate32 take the local date and timezone from a ZonedDateTime, discarding its time of day; their results remain SDK Values because Temporal has no zoned date-only type.
`TZDate` from `@date-fns/tz` is no longer supported; use ZonedDateTime or explicit timezone text.

#### Temporal setup

The SDK uses `globalThis.Temporal` supplied by the runtime or application and does not bundle, install or register a polyfill.
Ordinary JavaScript `Date` inputs and default result conversion do not require Temporal.
On runtimes with native Temporal, such as Node.js 26.3+ and Bun 1.4.3+, no setup is needed.
On Node.js 22/24, the application can install a polyfill:

```sh
npm install temporal-polyfill
```

Initialize it in the application's entry point before enabling Temporal results or constructing timezone parameters:

```ts
import 'temporal-polyfill/global'
```

TypeScript projects require TypeScript 7 or later.
The SDK declarations reference the standard `esnext.temporal` library, so consumers do not need to add it to `tsconfig.json` or install a separate type package.
These declarations do not provide a runtime implementation.

```ts
import { Timestamp } from '@ydbjs/value/primitive'

function parameter(instant: Temporal.Instant) {
  return new Timestamp(instant)
}
```

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

| JavaScript input                   | Inferred YDB type              | Notes                                                                              |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `boolean`                          | Bool                           |                                                                                    |
| Integer `number`                   | Int32                          | Use an explicit integer type when the required schema differs                      |
| Non-integer `number`               | Double                         |                                                                                    |
| `bigint`                           | Int64                          |                                                                                    |
| `string`                           | Utf8                           |                                                                                    |
| `Date`                             | Datetime                       | Second precision; use `Timestamp` explicitly for milliseconds                      |
| `Temporal.PlainDate`               | Date                           | ISO calendar; use `Date32` explicitly for the extended range                       |
| `Temporal.Instant`                 | Timestamp                      | Exact microseconds; use `Timestamp64` for the extended range                       |
| `Temporal.ZonedDateTime`           | TzTimestamp                    | ISO calendar and IANA timezone; use `TzTimestamp64` for the extended range         |
| `Temporal.Duration`                | Interval                       | Exact microseconds without calendar units; use `Interval64` for the extended range |
| `Uint8Array`                       | String                         | Binary data                                                                        |
| `Float32Array` / `Float64Array`    | `List<Float>` / `List<Double>` |                                                                                    |
| `BigInt64Array` / `BigUint64Array` | `List<Int64>` / `List<Uint64>` |                                                                                    |
| `null`                             | Null                           | Does not infer an Optional item type                                               |
| `Array`                            | List                           | Elements must have compatible types                                                |
| `Set`                              | Tuple                          | Elements may have different types                                                  |
| `Map`                              | Dict                           | Keys and values are converted recursively                                          |
| Plain object                       | Struct                         | Own enumerable fields are converted recursively                                    |

Temporal result options do not change parameter inference.
Use explicit constructors when a parameter requires a different precision or extended range; unsupported Temporal types such as PlainDateTime require an explicit conversion first.

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

Struct records use `Object.create(null)` recursively, including Structs inside containers. Field names such as `__proto__` and `constructor` are ordinary own properties. Use `Object.hasOwn(record, name)` instead of calling an inherited method. JSON-typed cells still use `JSON.parse`; their object prototypes are not changed.

`fromYdb(wireValue, wireType)` reconstructs a typed Value from a protobuf value and its schema.
It restores the supplied schema, including empty containers, absent Optionals, nested Optional presence, Tagged values, Void and PostgreSQL metadata.
For supported types, re-encoding produces a semantically equivalent type/value pair.
A schema containing Variant requires raw query results, including when the value is an absent Optional or an empty container.

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
This projection can lose information: different Optional levels become `null`, Lists and Tuples become arrays, and legacy Timestamp results lose sub-millisecond precision by default.
Use the typed Value when that distinction matters.
Tagged, Pg and Void have no automatic native projection: `toJs` returns the SDK Value unchanged, retaining its schema and typed fields.
This rule also applies recursively to those values inside arrays, structs, maps and Optionals.

| YDB type                                                               | JavaScript result                              |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| Bool                                                                   | `boolean`                                      |
| Int8/16/32, Uint8/16/32, Float, Double                                 | `number`                                       |
| Int64, Uint64                                                          | `bigint`                                       |
| Utf8, Uuid, DyNumber, Decimal                                          | `string`                                       |
| String, Yson                                                           | `Uint8Array`                                   |
| Json, JsonDocument                                                     | Parsed JavaScript value                        |
| Date                                                                   | `Date` at midnight UTC; day precision          |
| Datetime                                                               | `Date`; whole-second precision                 |
| Timestamp                                                              | `Date`; microseconds truncated to milliseconds |
| Date32, Datetime64, Timestamp64, Interval64                            | The same SDK Value                             |
| TzDate, TzDatetime, TzTimestamp, TzDate32, TzDatetime64, TzTimestamp64 | The same SDK Value                             |
| Interval                                                               | `number` of microseconds                       |
| Optional                                                               | Inner projection, or `null` when absent        |
| List, Tuple, EmptyList                                                 | Array                                          |
| Dict, EmptyDict                                                        | `Map`                                          |
| Struct                                                                 | Object with a null prototype                   |
| Null                                                                   | `null`                                         |
| Tagged, Pg, Void                                                       | The same SDK Value                             |

Decimal and DyNumber results remain strings to preserve numeric precision.
`Interval` accepts safe integer numbers of microseconds; the supported YDB Interval range fits exactly in a JavaScript number.

### Temporal results

After [setting up Temporal](#temporal-setup), use `toJs(value, { temporal: true })` to preserve exact date, instant and interval values:

```ts
import { toJs } from '@ydbjs/value'
import { Timestamp64 } from '@ydbjs/value/primitive'

let value = new Timestamp64(-1n)
toJs(value) // The same SDK Value
toJs(value, { temporal: true }) // Temporal.Instant: 1969-12-31T23:59:59.999999Z
```

| YDB type                   | Result with `temporal: true` | Preserved YDB precision |
| -------------------------- | ---------------------------- | ----------------------- |
| Date, Date32               | `Temporal.PlainDate`         | Days                    |
| Datetime, Datetime64       | `Temporal.Instant`           | Seconds                 |
| Timestamp, Timestamp64     | `Temporal.Instant`           | Microseconds            |
| Interval, Interval64       | `Temporal.Duration`          | Microseconds            |
| TzDatetime, TzDatetime64   | `Temporal.ZonedDateTime`     | Seconds                 |
| TzTimestamp, TzTimestamp64 | `Temporal.ZonedDateTime`     | Microseconds            |
| TzDate, TzDate32           | The same SDK Value           | Date and timezone       |

Temporal results retain the source precision without converting instants through JavaScript `Date`.
Timestamp microseconds are converted exactly to Temporal nanoseconds with bigint arithmetic; this does not add precision to the source value.

The option applies recursively inside Lists, Tuples, Dicts, Structs and Optionals; other projection rules remain the same.
Enabling it requires a global Temporal implementation even when the particular value contains no dates.
Keep the typed Value or use raw query results when timezone text cannot be converted unambiguously.
QueryClient and the tagged query API accept the same `temporal: true` option at client creation; see [Query value conversion](../query/README.md#value-conversion-and-type-safety).

### Variant results

Variant values are available only as raw protobuf results.
Typed decoding and Variant query parameters are unsupported, including Variant schemas nested inside other types.
Use raw results to inspect the value and its schema, or project the selected alternative and its discriminator explicitly in YQL.

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
