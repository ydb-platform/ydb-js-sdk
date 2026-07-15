# @ydbjs/core

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=core)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/packages/core/)

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

### Bridge (2DC) clusters

On a bridge cluster, discovery reports a pile per endpoint. The driver routes only to
endpoints whose pile is `PRIMARY`, `PROMOTED`, or `SYNCHRONIZED`; endpoints in any other
pile state (and any pile absent from `pile_states`) are kept out of the normal routing
tiers, used only as a last resort when every pile is unusable. To also keep traffic on
the primary pile — falling back to the synchronized pile only when the primary has no
available node — enable `ydb.sdk.prefer_primary_pile`:

```ts
const driver = new Driver('grpc://localhost:2136/local', {
  'ydb.sdk.prefer_primary_pile': true,
})
```

It is opt-in, soft (fallback preserved), and a no-op on a non-bridge cluster. In bridge
mode it takes precedence over `ydb.sdk.locality_enabled` (a pile already maps to a
datacenter, so the two are not combined).

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

### Conventions

All payloads share the same identity envelope, so multi-driver consumers can disambiguate:

```ts
type DriverIdentity = {
  database: string // YDB database path
  address: string // host the driver was constructed with
  port?: number // port the driver was constructed with, if any
}
```

The identity object reference is stable for the driver's lifetime, so subscribers
can use it directly as a `Map` / `WeakMap` key to attribute events per driver.

Time values follow Node.js conventions:

- **Durations** are in **milliseconds** (`performance.now()` deltas).
- **Timestamps** are in **epoch milliseconds** (`Date.now()`).
- Subscribers that target OTel attributes / instruments (whose canonical unit is seconds) divide by 1000 at the mapping layer — `@ydbjs/telemetry` does this for you.

### Channels

#### Driver lifecycle

| Channel             | Type    | Payload                                                             |
| ------------------- | ------- | ------------------------------------------------------------------- |
| `ydb:driver.ready`  | publish | `{ driver: DriverIdentity, duration: number }` (ms since `init`)    |
| `ydb:driver.failed` | publish | `{ driver: DriverIdentity, duration: number, error: unknown }` (ms) |
| `ydb:driver.closed` | publish | `{ driver: DriverIdentity, uptime: number }` (ms since `ready`)     |

#### Discovery

| Channel                          | Type    | Payload                                                                                                                                                                                                 |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracing:ydb:driver.discovery`   | tracing | `{ driver: DriverIdentity }`                                                                                                                                                                            |
| `ydb:driver.discovery.completed` | publish | `{ driver, addedCount, removedCount, totalCount, duration }` (ms) plus `selfLocation: string, piles: { name, status }[], primaryPile?: string` (topology roster; `piles` empty on a non-bridge cluster) |

#### Connection pool

All connection-pool channels carry `{ driver: DriverIdentity, nodeId: bigint, address: string, location: string, pile: string }` (`pile` is `''` on a non-bridge cluster) plus the extra field listed below.

| Channel                              | Type    | Extra fields                                                      |
| ------------------------------------ | ------- | ----------------------------------------------------------------- |
| `ydb:driver.connection.added`        | publish | (none) — also fired when a retired node reappears (revived)       |
| `ydb:driver.connection.pessimized`   | publish | (none) — pessimization has no fixed timer                         |
| `ydb:driver.connection.unpessimized` | publish | `duration: number` — ms the connection actually stayed pessimized |
| `ydb:driver.connection.retired`      | publish | `reason: 'stale_active' \| 'stale_pessimized'`                    |
| `ydb:driver.connection.removed`      | publish | `reason: 'idle' \| 'pool_close'`                                  |

The pool exposes two distinct teardown events for connections:

- `retired` — the connection was removed from active routing (its endpoint disappeared from discovery), but its gRPC channel is left open so in-flight streams can drain. A reappearing node revives the same channel and re-emits `connection.added`. A same-node address change re-dials silently: the old channel is dropped and the next RPC dials the new address — no `retired`/`removed` events fire, since the node identity is unchanged.
- `removed` — the gRPC channel was physically closed. The `reason` field distinguishes an idle teardown (`idle`) from a pool shutdown (`pool_close`).

`connection.added`/`retired`/`discovery.completed` for a discovery round are published inside the `tracing:ydb:driver.discovery` span, so trace subscribers see them as span events/attributes.

A gauge of "alive channels" can be reconstructed from the delta between `connection.added` and `connection.removed`. A gauge of "routable connections" should also subtract `retired`. `@ydbjs/telemetry` does this with an in-memory `Map<DriverIdentity, ConnectionState>`.

#### Bridge topology & pool stats

Additional channels surface bridge (2DC) topology and an aggregate routing snapshot. All carry `{ driver: DriverIdentity }`.

| Channel                             | Type    | Extra fields                                                                                                                                                                                   |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ydb:driver.connection.pool.opened` | publish | `config: { localityEnabled, preferPrimaryPile, degradedThreshold, discoveryIntervalMs, idleIntervalMs, retiredGraceMs, closeDeadlineMs }` — fired once at construction                         |
| `ydb:driver.connection.pool.stats`  | publish | `total, prefer, fallback, pessimized: number, piles: { name, status, nodes }[]` — emitted whenever routing changes                                                                             |
| `ydb:driver.pile.changed`           | publish | `selfLocation, before: {name,status}[], after: {name,status}[], primaryBefore?, primaryAfter?: string` — fired only when the pile roster/statuses change (published inside the discovery span) |
| `ydb:driver.pile.fallback`          | publish | `active: boolean, primaryPile?: string` — edge-triggered when `preferPrimaryPile` starts/stops serving from the SYNCHRONIZED fallback tier                                                     |

`pool.opened` is the config baseline for a subscriber that attaches before the first round; `pool.stats` is the topology baseline for one that attaches mid-life (it re-emits on every routable-set change). On a non-bridge cluster `piles` is empty, `pile.changed` never fires, and `pile.fallback` never fires (it is gated on `preferPrimaryPile`).

### Subscribing

```ts
import { channel, tracingChannel } from 'node:diagnostics_channel'

channel('ydb:driver.ready').subscribe((msg) => {
  console.log('driver ready', msg)
})

tracingChannel('tracing:ydb:driver.discovery').subscribe({
  start(ctx) {
    // ctx.driver.database === '/local'
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
    metrics.driverReady.add(1, { database: msg.driver.database })
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
