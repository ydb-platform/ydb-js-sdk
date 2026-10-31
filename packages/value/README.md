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

Value and type classes are exported from their subpaths, such as `@ydbjs/value/primitive`, `/optional`, `/list`, `/dict`, `/tuple`, `/struct`, and `/null`.
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
For supported types, it preserves the schema and value semantics, including empty containers, absent Optionals, and nested Optional presence.
It uses the supplied schema rather than inferring one from the contents; re-encoding the result produces a semantically equivalent type/value pair.

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

| YDB type                                                   | JavaScript result                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| Bool                                                       | `boolean`                                                   |
| Int8/16/32, Uint8/16/32, Float, Double                     | `number`                                                    |
| Int64, Uint64                                              | `bigint`                                                    |
| Utf8, Uuid, DyNumber, Decimal                              | `string`                                                    |
| String, Yson                                               | `Uint8Array`                                                |
| Json, JsonDocument                                         | Parsed JavaScript value                                     |
| Date, Date32, Datetime, Datetime64, Timestamp, Timestamp64 | `Date` with millisecond precision                           |
| TzDate, TzDatetime, TzTimestamp                            | `TZDate` with millisecond precision in the encoded timezone |
| Interval                                                   | `number` of microseconds                                    |
| Interval64                                                 | `bigint` of microseconds                                    |
| Optional                                                   | Inner projection, or `null` when absent                     |
| List, Tuple, EmptyList                                     | Array                                                       |
| Dict, EmptyDict                                            | `Map`                                                       |
| Struct                                                     | Object with own data properties                             |
| Null                                                       | `null`                                                      |

Decimal and DyNumber results remain strings to preserve numeric precision.
`Interval` accepts safe integer numbers of microseconds; the supported YDB Interval range fits exactly in a JavaScript number.

## Exact scalar construction

Import `Decimal`/`DecimalType` from `@ydbjs/value/decimal`, and `EmptyList`/`EmptyDict` from `@ydbjs/value/empty`.
`new Decimal('1.23', new DecimalType(22, 9))` parses exact decimal text without rounding; bigint input is the scaled coefficient.
Special values are `inf`, `-inf` and `nan`.

The primitive subpath exports named Date32, Datetime64, Timestamp64, Interval64 and DyNumber constructors.
Date32 accepts a Date or an integer day count; Datetime64 and Timestamp64 accept a Date or exact bigint seconds/microseconds.
Interval64 accepts bigint or safe integer microseconds; DyNumber accepts decimal text.
Date, Datetime and Timestamp also accept exact day/second/microsecond units.

TzDate32, TzDatetime64 and TzTimestamp64 use the server IDs 68–70, which are absent from the public protobuf enum.
All timezone constructors accept a TZDate or an exact YDB string such as `-1-02-29T12:34:56.123456,UTC`.
YDB has no year zero; JS astronomical year zero corresponds to YDB year -1.
Typed values preserve microseconds; native Date/TZDate projection keeps millisecond precision.
The timezone text does not contain a DST fold marker, so it cannot distinguish both instants of an overlapping wall-clock time.

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
