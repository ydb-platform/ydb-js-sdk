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
npm install @ydbjs/value@6.0.0-alpha.2
```

## Usage

### Encoding JavaScript Values to YDB Values

```ts
import { fromJs } from '@ydbjs/value';
const ydbValue = fromJs({ key: 'value' });
```

### Decoding YDB Values to JavaScript

```ts
import { toJs } from '@ydbjs/value';
const jsValue = toJs(ydbValue);
```

### Working with YDB Types

```ts
import { Int32Type } from '@ydbjs/value/primitive';
const intType = new Int32Type();
```

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
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
