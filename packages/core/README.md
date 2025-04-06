# @ydbjs/core

The `@ydbjs/core` package provides core utilities and foundational components for interacting with YDB services in JavaScript/TypeScript. It serves as the backbone for other YDB-related packages, offering shared functionality and abstractions.

## Features

- Core utilities for YDB service interaction.
- TypeScript support for type safety and autocompletion.
- Lightweight and modular design.
- Compatible with Node.js and modern JavaScript runtimes.

## Installation

To install the package, use your preferred package manager:

```bash
npm install @ydbjs/core@6.0.0-alpha.2
```

## Usage

### Create generic gRPC Client

```ts
import { Driver } from '@ydbjs/core';

// Example usage
let driver = new Driver("grpc://localhost:2136");
await driver.ready()

let client = driver.createClient(/* gRPC Service Defenitions */)
client.invokeSomeMethod()
```

## Development

### Building the Package

To build the package, run:

```bash
npm run build
```

This will generate both CommonJS and ES Module outputs in the `dist/` directory.

### Running Tests

To run the tests, use:

```bash
npm test
```

For watch mode during development:

```bash
npm run test:watch
```

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bugfix.
3. Commit your changes with clear messages.
4. Submit a pull request.

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
