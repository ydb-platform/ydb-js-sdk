# @ydbjs/auth

The `@ydbjs/auth` package provides authentication utilities for interacting with YDB services. It supports static credentials, token-based authentication, anonymous access, and VM metadata providers.

## Features

- Static credentials support
- Token-based authentication
- Anonymous access for development and testing
- VM metadata authentication (Google Cloud, Yandex Cloud)
- Environment-based auto-detection of auth method and TLS
- TypeScript support with type definitions

## Installation

Install the package using npm:

```sh
npm install @ydbjs/auth
```

---

## How Authentication Works with YDB

YDB requires authentication for most operations. The credentials provider you choose attaches authentication data to each gRPC request:

- **Static credentials**: The SDK sends your username and password to the YDB AuthService using a gRPC call. The server responds with a session token. This token is then sent as a header (`x-ydb-auth-ticket: <token>`) in all subsequent requests. The SDK automatically refreshes the token when it expires.
- **Access token**: The SDK sends the provided token directly as a header (`x-ydb-auth-ticket: <token>`) with every request. No login call is made.
- **Anonymous**: No authentication headers are sent. This is useful for local development or open databases.
- **VM Metadata**: The SDK fetches a token from your cloud provider's metadata service (e.g., Google Cloud, Yandex Cloud) and sends it as a header (`x-ydb-auth-ticket: <token>`). The token is refreshed automatically as needed.

> **Note:** The SDK handles all token management and header injection automatically when you pass a credentials provider to the YDB driver. You do not need to manually manage tokens or headers.

---

## Usage

### Using with YDB Driver

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'

const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: new StaticCredentialsProvider({
    username: 'username',
    password: 'password',
  }),
})
await driver.ready()

const sql = query(driver)
const result = await sql`SELECT 1`
```

### Static Credentials (Manual Usage)

```ts
import { StaticCredentialsProvider } from '@ydbjs/auth/static'

const provider = new StaticCredentialsProvider(
  {
    username: 'username',
    password: 'password',
  },
  'grpc://localhost:2136/local'
)

const token = await provider.getToken()
// The token can be used in custom gRPC calls if needed
```

### Token-Based Authentication

```ts
import { AccessTokenCredentialsProvider } from '@ydbjs/auth/access-token'

const provider = new AccessTokenCredentialsProvider({
  token: 'your-access-token',
})

// Use with driver
import { Driver } from '@ydbjs/core'
const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: provider,
})
await driver.ready()
```

### Anonymous Access

```ts
import { Driver } from '@ydbjs/core'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'

const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: new AnonymousCredentialsProvider(),
})
await driver.ready()
```

### VM Metadata Authentication (Cloud)

```ts
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata'

const provider = new MetadataCredentialsProvider({
  // Optional: override endpoint or flavor for your cloud
  // endpoint: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
  // flavor: 'Google',
})

import { Driver } from '@ydbjs/core'
const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: provider,
})
await driver.ready()
```

### Environment-Based Auto-Detection

`EnvironCredentialsProvider` auto-detects the authentication method and TLS configuration from environment variables:

```ts
import { Driver } from '@ydbjs/core'
import { EnvironCredentialsProvider } from '@ydbjs/auth/environ'

let cs = process.env.YDB_CONNECTION_STRING!
let creds = new EnvironCredentialsProvider(cs)

let driver = new Driver(cs, {
  credentialsProvider: creds,
  secureOptions: creds.secureOptions,
})
await driver.ready()
```

Credentials are detected in priority order:

| Variable                            | Auth method                                             |
| ----------------------------------- | ------------------------------------------------------- |
| `YDB_ANONYMOUS_CREDENTIALS=1`       | Anonymous                                               |
| `YDB_METADATA_CREDENTIALS=1`        | Cloud metadata                                          |
| `YDB_METADATA_CREDENTIALS_ENDPOINT` | Custom metadata endpoint (default: GCE metadata)        |
| `YDB_METADATA_CREDENTIALS_FLAVOR`   | Custom metadata flavor (default: `Google`)              |
| `YDB_ACCESS_TOKEN_CREDENTIALS`      | Access token                                            |
| `YDB_STATIC_CREDENTIALS_USER`       | Username for static auth                                |
| `YDB_STATIC_CREDENTIALS_PASSWORD`   | Password (default: empty)                               |
| `YDB_STATIC_CREDENTIALS_ENDPOINT`   | Auth endpoint (default: derived from connection string) |

TLS options are read from `YDB_SSL_ROOT_CERTIFICATES_FILE` / `YDB_SSL_ROOT_CERTIFICATES`, `YDB_SSL_CERTIFICATE_FILE` / `YDB_SSL_CERTIFICATE`, `YDB_SSL_PRIVATE_KEY_FILE` / `YDB_SSL_PRIVATE_KEY`. See the [environ example](../../examples/environ/) for full details.

---

## What is Sent to YDB Server

- For **Static Credentials** and **VM Metadata**: The SDK first obtains a token (via login or metadata service), then sends `x-ydb-auth-ticket: <token>` in every gRPC request.
- For **Access Token**: The SDK sends `x-ydb-auth-ticket: <token>` in every gRPC request.
- For **Anonymous**: No authentication header is sent.

You do not need to manually set headers; the SDK handles this for you.

---

## Observability via `node:diagnostics_channel`

`@ydbjs/auth` publishes events to [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) so external subscribers (`@ydbjs/telemetry`, OpenTelemetry, custom loggers) can build traces and metrics for token lifecycle without coupling the SDK to a specific telemetry stack.

### Channels

| Channel                        | Type    | Payload                                                                             |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------- |
| `tracing:ydb:auth.token.fetch` | tracing | `{ provider: string }` — wraps the full token fetch (with retries)                  |
| `ydb:auth.token.refreshed`     | publish | `{ provider: string, expiresAt: number }` — unix milliseconds                       |
| `ydb:auth.token.expired`       | publish | `{ provider: string, stalenessMs: number }` — fires once per incident, not per call |
| `ydb:auth.provider.failed`     | publish | `{ provider: string, error: unknown }` — fires after all retries are exhausted      |

### `provider` values

The `provider` field is an open, extensible string set. Built-in values published
by SDK packages:

- `'static'` — `StaticCredentialsProvider` (username/password → JWT via Auth API)
- `'metadata'` — `MetadataCredentialsProvider` (cloud metadata service)
- `'yc-service-account'` — `ServiceAccountCredentialsProvider` from `@ydbjs/auth-yandex-cloud`

Third-party `CredentialsProvider` implementations are expected to mint their own
stable, namespaced provider id and document it. Subscribers should not assume the
set is exhaustive — prefer label-based metric attributes over hard-coded switches
over provider names.

### Per-incident `token.expired` semantics

`ydb:auth.token.expired` fires **once** per expiration incident, even if many concurrent calls observe the same expired cached token. The flag is reset on every successful refresh, so the next expiration produces a new event. This makes the channel suitable as a counter for "token went stale" incidents rather than "calls hit a stale cache".

### Subscribing

```ts
import { channel, tracingChannel } from 'node:diagnostics_channel'

tracingChannel('tracing:ydb:auth.token.fetch').subscribe({
  start(ctx) {
    span.start({ name: 'auth.token.fetch', attributes: { 'auth.provider': ctx.provider } })
  },
  asyncEnd() {
    span.end()
  },
  error(ctx) {
    span.recordException(ctx.error)
    span.end()
  },
})

channel('ydb:auth.token.expired').subscribe((msg) => {
  metrics.tokenExpired.add(1, { provider: msg.provider })
})
```

Retry-loop spans are emitted from `@ydbjs/retry` automatically (`tracing:ydb:retry.run`, `tracing:ydb:retry.attempt`, `ydb:retry.exhausted`) and nest correctly under the `auth.token.fetch` span via `AsyncLocalStorage` propagation.

### ⚠️ Subscribers must be safe

**`node:diagnostics_channel` invokes subscribers synchronously.** Any exception thrown inside a subscriber propagates up the call stack and **will** disrupt the SDK — a buggy subscriber can break a `getToken()` call. `@ydbjs/auth` does **not** wrap your subscribers; wrap them yourself in `try/catch`.

### Stability

Channel names and payload field names follow semantic versioning. The `provider` field is an **open string set** (custom `CredentialsProvider` implementations may contribute new values), so subscribers should treat it as a label — adding new providers is a minor change. Renaming or removing channels or fields is a major change.

---

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
