# @ydbjs/value

The `@ydbjs/value` package provides utilities for working with YDB values and types in JavaScript/TypeScript. It includes classes and functions for encoding, decoding, and converting YDB values to and from native JavaScript types.

## Features

- Support for all YDB primitive types (e.g., BOOL, INT32, STRING, etc.)
- Support for complex types like List, Tuple, Struct, Dict, and Optional
- Conversion between YDB values and native JavaScript types
- Type-safe handling of YDB values with TypeScript

## Installation

Install the package using npm:

```sh
npm install @ydbjs/value@alpha
```

## Usage

### Encoding JavaScript Values to YDB Values

```ts
import { fromJs } from '@ydbjs/value'
const ydbValue = fromJs({ key: 'value' })
```

### Decoding YDB Values to JavaScript

```ts
import { toJs } from '@ydbjs/value'
const jsValue = toJs(ydbValue)
```

### Working with YDB Types

```ts
import { Int32Type } from '@ydbjs/value/primitive'
const intType = new Int32Type()
```

## Conversion Stages

Conversion from JavaScript values to YDB server values occurs in three stages:

1. **JavaScript value → Value (from @ydbjs/value)**
   Use the `fromJs` function to convert a native JavaScript value into a `Value` instance from the `@ydbjs/value` package. This step infers the YDB type and wraps the value in a type-safe class.

2. **Value → Ydb.Value (protobuf)**
   Call the `.encode()` method on the `Value` instance to produce a protobuf-compatible `Ydb.Value` object. This object can be sent to the YDB server via gRPC or other supported protocols.

3. **Ydb.Value → YDB server**
   The encoded `Ydb.Value` is transmitted to the YDB server as part of your request payload.

This multi-stage process ensures type safety, correct serialization, and compatibility with the YDB protocol.

# Type Conversion Details

The conversion between JavaScript and YDB types in `@ydbjs/value` is automatic and based on the structure and type of the input value. Below is a summary of how different JavaScript values are converted:

| JavaScript Value   | YDB Type/Class | Notes                                                                             |
| ------------------ | -------------- | --------------------------------------------------------------------------------- |
| `boolean`          | Bool           |                                                                                   |
| `number` (integer) | Int32          | Uses Int32 for integers                                                           |
| `number` (float)   | Double         | Uses Double for non-integers                                                      |
| `bigint`           | Int64          |                                                                                   |
| `string`           | Text           |                                                                                   |
| `Date`             | Datetime       |                                                                                   |
| `Uint8Array`       | Bytes          |                                                                                   |
| `null`             | Null           |                                                                                   |
| `Array`            | List           | Elements converted recursively. Special handling for arrays of objects, see below |
| `Set`              | Tuple          | Elements converted recursively                                                    |
| `Map`              | Dict           | Keys and values converted recursively                                             |
| Plain object       | Struct         | Each property converted recursively                                               |

### Special Handling for Arrays of Objects

If you pass an array of objects with different sets of fields, the converter will automatically create a unified Struct type containing all fields from all objects. Missing fields in each object will be set as Optional (nullable) in the resulting YDB Struct. This allows you to pass heterogeneous arrays of objects and have them represented as a single List of Structs in YDB.

#### Example

```js
fromJs([
  { id: 1, name: 'Alice' },
  { id: 2, age: 30 },
])
```

This will produce a YDB List where each element is a Struct with fields: `id`, `name`, and `age`. Fields not present in an object will be set to null (Optional).

### Utility Exports

- All type and value classes (e.g., `Struct`, `List`, `Dict`, `Tuple`, `Null`, `Optional`, `Primitive`) are exported for advanced use.
- Conversion is two-way: use `fromJs` for JS → YDB and `toJs` for YDB → JS.

---

## Additional Utility Functions

- `printYdbValue(value: YdbValue): string` — Returns a human-readable string representation of a YDB value.

---

## More Examples

### Primitives

```ts
import { fromJs, toJs } from '@ydbjs/value'

const intValue = fromJs(42)
const boolValue = fromJs(true)
const stringValue = fromJs('hello')

console.log(toJs(intValue)) // 42
console.log(toJs(boolValue)) // true
console.log(toJs(stringValue)) // 'hello'
```

### Container Types (List, Dict, Tuple, Optional)

```ts
import { fromJs, toJs } from '@ydbjs/value'

// List of integers
const ydbList = fromJs([1, 2, 3])
console.log(toJs(ydbList)) // [1, 2, 3]

// Dictionary (map) from string to int
const ydbDict = fromJs({ a: 1, b: 2 })
console.log(toJs(ydbDict)) // { a: 1, b: 2 }

// Optional value
const ydbOptional = fromJs(null)
console.log(toJs(ydbOptional)) // null
```

### Complex Values (Struct, Tuple)

```ts
import { fromJs, toJs } from '@ydbjs/value'

// Struct
const ydbStruct = fromJs({ id: 123, name: 'Alice' })
console.log(toJs(ydbStruct)) // { id: 123, name: 'Alice' }

// Tuple (represented as array)
const ydbTuple = fromJs([42, 'foo'])
console.log(toJs(ydbTuple)) // [42, 'foo']
```

---

## Conversion Mechanism

The conversion between JavaScript and YDB values is handled by the `fromJs` and `toJs` functions:

- `fromJs(jsValue)` encodes a native JavaScript value into a YDB value. The type is inferred automatically from the value structure.
- `toJs(ydbValue)` decodes a YDB value back to a native JavaScript value, preserving structure and types.

YDB types are represented internally and are inferred automatically based on the structure of the provided value. For complex or nested structures, conversion is also performed automatically.

## Development

### Building the Package

```sh
npm run build
```

### Running Tests

```sh
npm test
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
