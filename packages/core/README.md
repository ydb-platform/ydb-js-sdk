# @ydbjs/core

The `@ydbjs/core` package provides core utilities and foundational components for interacting with YDB services in JavaScript/TypeScript. It serves as the backbone for other YDB-related packages, offering shared functionality and abstractions.

## Features

- Core utilities for YDB service interaction.
- TypeScript support for type safety and autocompletion.
- Lightweight and modular design.
- Compatible with Node.js and modern JavaScript runtimes.

## Installation

Install the package using npm:

```sh
npm install @ydbjs/core@6.0.0-alpha.2
```

## Usage

### Creating a gRPC Client

```ts
import { Driver } from '@ydbjs/core';

const driver = new Driver('grpc://localhost:2136');
await driver.ready();

const client = driver.createClient(/* gRPC Service Definitions */);
client.invokeSomeMethod();
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
