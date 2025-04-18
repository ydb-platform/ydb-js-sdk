# @ydbjs/error

The `@ydbjs/error` package provides utilities for handling YDB-specific errors in JavaScript/TypeScript applications. It simplifies error classification and provides detailed error messages for better debugging and troubleshooting.

## Features

- Error classification for YDB-specific error codes
- Detailed error messages with severity levels
- TypeScript support with type definitions

## Installation

Install the package using npm:

```sh
npm install @ydbjs/error@6.0.0-alpha.2
```

## Usage

### Handling YDB Errors

```ts
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';

try {
  throw new YDBError(StatusIds_StatusCode.ABORTED, [
    { severity: 0, issueCode: 14, message: 'Some error message' },
  ]);
} catch (error) {
  if (error instanceof YDBError) {
    console.error('YDB Error:', error.message);
    console.error('Error Code:', error.code);
  }
}
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

For watch mode during development:

```sh
npm run test:watch
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
