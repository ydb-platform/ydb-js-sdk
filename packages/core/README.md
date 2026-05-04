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
npm install @ydbjs/core
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

## Observability via `node:diagnostics_channel`

`@ydbjs/core` publishes domain events over [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) so external subscribers (`@ydbjs/telemetry`, OpenTelemetry, custom loggers) can build traces, metrics, and logs without the driver knowing anything about them.

Two primitives are used:

- **`channel.publish`** — point-in-time state changes (gauges, counters, structured logs).
- **`tracingChannel.tracePromise`** — bracketed operations with duration and possible error (spans, latency histograms).

### Channels

#### Driver lifecycle

| Channel             | Type    | Payload                                                  |
| ------------------- | ------- | -------------------------------------------------------- |
| `ydb:driver.ready`  | publish | `{ database: string, duration: number }`                 |
| `ydb:driver.failed` | publish | `{ database: string, duration: number, error: unknown }` |
| `ydb:driver.closed` | publish | `{ database: string, uptime: number }`                   |

#### Discovery

| Channel                   | Type    | Payload                                                                                                |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `tracing:ydb:discovery`   | tracing | `{ database: string }`                                                                                 |
| `ydb:discovery.completed` | publish | `{ database: string, addedCount: number, removedCount: number, totalCount: number, duration: number }` |

#### Connection pool

| Channel                            | Type    | Payload                                                                                               |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `ydb:pool.connection.added`        | publish | `{ nodeId: bigint, address: string, location: string }`                                               |
| `ydb:pool.connection.pessimized`   | publish | `{ nodeId: bigint, address: string, location: string, until: number }`                                |
| `ydb:pool.connection.unpessimized` | publish | `{ nodeId: bigint, address: string, location: string, pessimizedDuration: number }`                   |
| `ydb:pool.connection.retired`      | publish | `{ nodeId: bigint, address: string, location: string, reason: 'stale_active' \| 'stale_pessimized' }` |
| `ydb:pool.connection.removed`      | publish | `{ nodeId: bigint, address: string, location: string, reason: 'replaced' \| 'idle' \| 'pool_close' }` |

The pool exposes two distinct lifecycle events for connections:

- `retired` — the connection was removed from active routing (e.g. its endpoint disappeared from discovery), but its gRPC channel is left open so in-flight streams can drain.
- `removed` — the gRPC channel was physically closed. The `reason` field distinguishes whether it was a replacement, an idle teardown, or a pool shutdown.

A gauge of "alive channels" can be reconstructed from the delta between `pool.connection.added` and `pool.connection.removed`. A gauge of "routable connections" should also subtract `retired`.

### Subscribing

```ts
import { channel, tracingChannel } from 'node:diagnostics_channel'

channel('ydb:driver.ready').subscribe((msg) => {
  console.log('driver ready', msg)
})

tracingChannel('tracing:ydb:discovery').subscribe({
  start(ctx) {
    // ctx.database === '/local'
  },
  asyncEnd(ctx) {
    // discovery round succeeded
  },
  error(ctx) {
    // ctx.error is the failure
  },
})
```

### ⚠️ Subscribers must be safe

**`node:diagnostics_channel` invokes subscribers synchronously, on the publishing thread.** Any exception thrown inside a subscriber propagates up the call stack and **will** disrupt the SDK — a buggy subscriber can break a `Driver.ready()`, abort a discovery round, or leak a gRPC channel.

`@ydbjs/core` does **not** wrap your subscribers. It is your responsibility to keep them safe:

```ts
channel('ydb:driver.ready').subscribe((msg) => {
  try {
    metrics.driverReady.add(1, { database: msg.database })
  } catch (err) {
    // Never let a metrics failure escape — log it locally and move on.
    console.error('telemetry subscriber failed', err)
  }
})
```

The same applies to `tracingChannel` handlers (`start`, `asyncEnd`, `error`, etc.) — each must be self-contained and never throw.

### Stability

Channel names and payload field names follow semantic versioning. Adding new optional fields is a minor change; renaming or removing fields is a major change. Treat the channel names and payload shapes as a public API surface.

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
