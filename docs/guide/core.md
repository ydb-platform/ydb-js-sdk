---
title: Getting Started
---

# Getting Started with YDB JS SDK

This guide helps you connect to YDB from JavaScript/TypeScript and run your first queries. Examples use `@ydbjs/core`.

## Connection string

- Format: `grpc://host:port/database` or `grpcs://host:port/database` (TLS)
- Example: `grpcs://ydb.example.com:2135/ru-central1/b1.../etn...`

## Quick start

```ts
import { Driver } from '@ydbjs/core'

using driver = new Driver(process.env['YDB_CONNECTION_STRING'] || 'grpc://localhost:2136/local')
await driver.ready()

// use the driver with Query/Topic or low-level clients
```

## Authentication providers (`@ydbjs/auth`)

Pass `credentialsProvider` in the driver options. Supported strategies:

### 1) Access Token

```ts
import { Driver } from '@ydbjs/core'
import { AccessTokenCredentialsProvider } from '@ydbjs/auth/access-token'

const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  credentialsProvider: new AccessTokenCredentialsProvider({
    token: process.env.YDB_TOKEN!,
  }),
})
await driver.ready()
```

### 2) Static Credentials (username/password)

```ts
import { Driver } from '@ydbjs/core'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'

const authEndpoint = 'grpcs://ydb.example.com:2135' // AuthService endpoint
const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  credentialsProvider: new StaticCredentialsProvider(
    {
      username: process.env.YDB_USER!,
      password: process.env.YDB_PASSWORD!,
    },
    authEndpoint
  ),
})
await driver.ready()
```

### 3) Metadata (cloud)

```ts
import { Driver } from '@ydbjs/core'
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata'

const driver = new Driver(process.env.YDB_CONNECTION_STRING!, {
  credentialsProvider: new MetadataCredentialsProvider({
    // endpoint?: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token'
  }),
})
await driver.ready()
```

### 4) Anonymous (local/public DBs)

```ts
import { Driver } from '@ydbjs/core'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'

const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: new AnonymousCredentialsProvider(),
})
await driver.ready()
```

### 5) Environment-Based Auto-Detection

`EnvironCredentialsProvider` reads environment variables and picks the right auth strategy automatically. It also detects TLS configuration.

```ts
import { Driver } from '@ydbjs/core'
import { EnvironCredentialsProvider } from '@ydbjs/auth/environ'

let cs = process.env['YDB_CONNECTION_STRING']!
let creds = new EnvironCredentialsProvider(cs)

const driver = new Driver(cs, {
  credentialsProvider: creds,
  secureOptions: creds.secureOptions,
})
await driver.ready()
```

Detection priority (first match wins):

| Variable                            | Description                                             |
| ----------------------------------- | ------------------------------------------------------- |
| `YDB_ANONYMOUS_CREDENTIALS=1`       | Anonymous                                               |
| `YDB_METADATA_CREDENTIALS=1`        | Cloud metadata                                          |
| `YDB_METADATA_CREDENTIALS_ENDPOINT` | Custom metadata endpoint (default: GCE metadata)        |
| `YDB_METADATA_CREDENTIALS_FLAVOR`   | Custom metadata flavor (default: `Google`)              |
| `YDB_ACCESS_TOKEN_CREDENTIALS`      | Access token                                            |
| `YDB_STATIC_CREDENTIALS_USER`       | Username for static auth                                |
| `YDB_STATIC_CREDENTIALS_PASSWORD`   | Password (default: empty)                               |
| `YDB_STATIC_CREDENTIALS_ENDPOINT`   | Auth endpoint (default: derived from connection string) |

TLS is configured via `YDB_SSL_ROOT_CERTIFICATES_FILE` (or `YDB_SSL_ROOT_CERTIFICATES` for PEM string), `YDB_SSL_CERTIFICATE_FILE` / `YDB_SSL_CERTIFICATE`, `YDB_SSL_PRIVATE_KEY_FILE` / `YDB_SSL_PRIVATE_KEY`.

## TLS and mTLS in Driver

Pass `secureOptions` (Node.js `tls.SecureContextOptions`). For `grpcs://...`, system CA store is used by default; `secureOptions` lets you provide custom roots/certificates.

### TLS with custom CA

```ts
import { Driver } from '@ydbjs/core'
import * as fs from 'node:fs'

const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  secureOptions: {
    ca: fs.readFileSync('/etc/ssl/custom/ca.pem'),
    servername: 'ydb.example.com', // SNI if needed
  },
})
await driver.ready()
```

### mTLS (client cert + key)

```ts
import { Driver } from '@ydbjs/core'
import * as fs from 'node:fs'

const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  secureOptions: {
    ca: fs.readFileSync('/etc/ssl/custom/ca.pem'),
    cert: fs.readFileSync('/etc/ssl/custom/client.crt'),
    key: fs.readFileSync('/etc/ssl/custom/client.key'),
    // passphrase?: '...',
  },
})
await driver.ready()
```

## TLS/mTLS for StaticCredentialsProvider

The Static provider authenticates against AuthService via gRPC. You can pass separate `secureOptions` for the auth channel:

```ts
import { Driver } from '@ydbjs/core'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import * as fs from 'node:fs'

const authEndpoint = 'grpcs://ydb.example.com:2135'
const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  credentialsProvider: new StaticCredentialsProvider(
    {
      username: 'user',
      password: 'pass',
    },
    authEndpoint,
    {
      ca: fs.readFileSync('/etc/ssl/custom/ca.pem'),
      cert: fs.readFileSync('/etc/ssl/custom/client.crt'), // for mTLS
      key: fs.readFileSync('/etc/ssl/custom/client.key'), // for mTLS
    }
  ),
})
await driver.ready()
```

## Build your own provider

Implement `CredentialsProvider.getToken(force?, signal?)`. The Driver obtains the token and sets `x-ydb-auth-ticket`, database and SDK headers before sending the RPC. The provider owns its cache and token refresh; it does not install middleware.

Concurrent callers should share one refresh. In this example, `fetchTokenSomehow(signal)` performs the token request and returns `{ value, expiresAt }`, where `expiresAt` is the token's expiry time in Unix milliseconds. Pass the provider's signal to that network request.

```ts
import { abortable } from '@ydbjs/abortable'
import { CredentialsProvider } from '@ydbjs/auth'
import { Driver } from '@ydbjs/core'

class MyCredentialsProvider extends CredentialsProvider {
  #token: { value: string; expiresAt: number } | undefined
  #refreshPromise: Promise<string> | undefined

  async getToken(force = false, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (!force && this.#token && this.#token.expiresAt > Date.now()) {
      return this.#token.value
    }

    if (!this.#refreshPromise) {
      let timeout = AbortSignal.timeout(5000)
      this.#refreshPromise = fetchTokenSomehow(timeout)
        .then((token) => {
          this.#token = token
          return token.value
        })
        .finally(() => {
          this.#refreshPromise = undefined
        })
    }

    return signal ? abortable(signal, this.#refreshPromise) : this.#refreshPromise
  }
}

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!, {
  credentialsProvider: new MyCredentialsProvider(),
})
await driver.ready()
```

The timeout is created only when a new token request starts. A cached read or a caller joining the existing refresh creates no additional provider timeout. The refresh clears `#refreshPromise` on both success and failure, so a later call can try again. Providers with short-lived tokens can also start a refresh before expiry while continuing to return the current token.

### RPC deadline and caller cancellation

The Driver calls `getToken()` without the RPC signal. It limits its own wait with `ydb.sdk.token_timeout_ms` (default 10000 ms), the call deadline and caller cancellation. A token-wait timeout rejects with `Status.DEADLINE_EXCEEDED`; cancellation preserves the caller's original reason. The same absolute RPC deadline covers authorization and the RPC itself, without restarting after token acquisition.

For callers that invoke `provider.getToken(false, signal)` directly, `abortable` cancels only their wait. The shared request continues under its provider-owned timeout, can populate the cache and remains available to other callers. Cancelling one RPC or closing its Driver therefore does not cancel a refresh used by another request.

## Low-level service clients

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

let discovery = driver.createClient(DiscoveryServiceDefinition)
let response = await discovery.listEndpoints({ database: driver.database })
console.log(response)
```

See also “Advanced → Low-level clients (driver)”.
