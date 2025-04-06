# @ydbjs/error

The `@ydbjs/error` package provides utilities for handling YDB-specific errors in JavaScript/TypeScript applications. It simplifies error classification and provides detailed error messages for better debugging and troubleshooting.

## Features

- 🛠️ Error classification for YDB-specific error codes.
- 📋 Detailed error messages with severity levels.
- ✅ TypeScript support with type definitions.

## Installation

Install the package using your preferred package manager:

```bash
npm install @ydbjs/error
```

## Usage

### Handling YDB Errors

The `YDBError` class allows you to handle errors returned by YDB services. It provides detailed error messages and severity levels.

```ts
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';

try {
    // Simulate an operation that throws an error
    throw new YDBError(StatusIds_StatusCode.ABORTED, [
        { severity: 0, issueCode: 14, message: "Some error message" },
    ]);
} catch (error) {
    if (error instanceof YDBError) {
        console.error('YDB Error:', error.message);
        console.error('Error Code:', error.code);
    }
}
```

### Severity Levels

The `YDBError` class categorizes issues into the following severity levels:

- `FATAL` (0)
- `ERROR` (1)
- `WARNING` (2)
- `INFO` (3)

## Development

### Building the Package

To build the package, run:

```bash
npm run build
```

### Running Tests

To run the tests, use:

```bash
npm test
```

For watch mode during development:

```bash
npm run test:watch
```

## License

This project is licensed under the [Apache 2.0 License](https://www.apache.org/licenses/LICENSE-2.0).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
