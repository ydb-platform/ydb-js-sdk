# @ydbjs/core

The `@ydbjs/core` package provides the core driver and connection management for YDB in JavaScript/TypeScript. It is the foundation for all YDB client operations, handling connection pooling, service client creation, authentication, and middleware.

## Features

- Connection pooling and load balancing for YDB endpoints
- Service client creation for any YDB gRPC API
- Pluggable authentication via `@ydbjs/auth` providers
- Automatic endpoint discovery and failover
- TypeScript support with type definitions
- Compatible with Node.js and modern runtimes

## Installation

```sh
npm install @ydbjs/core@alpha
```

## How It Works

- **Driver**: The main entry point. Manages connections, endpoint discovery, and authentication.
- **Connection Pool**: Maintains and balances gRPC channels to YDB endpoints.
- **Service Clients**: Use `driver.createClient(ServiceDefinition)` to get a typed client for any YDB gRPC service (from `@ydbjs/api`).
- **Authentication**: Pass a credentials provider from `@ydbjs/auth` to the driver for static, token, anonymous, or cloud metadata authentication.
- **Middleware**: Internal middleware handles metadata, authentication, and debugging.

## Usage

### Basic Example

```ts
import { Driver } from '@ydbjs/core'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const discovery = driver.createClient(DiscoveryServiceDefinition)
const endpoints = await discovery.listEndpoints({ database: '/local' })
console.log(endpoints)

await driver.close()
```

### Using Authentication Providers

```ts
import { Driver } from '@ydbjs/core'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'

const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: new StaticCredentialsProvider({
    username: 'user',
    password: 'pass',
  }),
})
await driver.ready()
// ...
```

You can also use `AccessTokenCredentialsProvider`, `AnonymousCredentialsProvider`, or `MetadataCredentialsProvider` from `@ydbjs/auth`.

### Closing the Driver

Always close the driver when done to release resources:

```ts
driver.close()
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
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
