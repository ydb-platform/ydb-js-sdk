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

const driver = new Driver(
  process.env['YDB_CONNECTION_STRING'] || 'grpc://localhost:2136/local'
)
await driver.ready()

// use the driver with Query/Topic or low-level clients

await driver.close()
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
    { username: process.env.YDB_USER!, password: process.env.YDB_PASSWORD! },
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

Implement `CredentialsProvider` with `getToken(force?, signal?)`. The provider middleware automatically sets `x-ydb-auth-ticket` for all calls.

```ts
import { CredentialsProvider } from '@ydbjs/auth'

class MyCredentialsProvider extends CredentialsProvider {
  #token: string | null = null
  async getToken(force = false, signal?: AbortSignal): Promise<string> {
    if (!force && this.#token) return this.#token
    const token = await fetchTokenSomehow(signal)
    this.#token = token
    return token
  }
}

const driver = new Driver(process.env.YDB_CONNECTION_STRING!, {
  credentialsProvider: new MyCredentialsProvider(),
})
```

Tips:

- Cache the token and refresh it proactively (like `StaticCredentialsProvider`).
- Mind timeouts: `ydb.sdk.token_timeout_ms` in driver options.

### Why AbortSignal matters and how to handle aborts

- The driver passes a timed `signal` to `getToken()` (`ydb.sdk.token_timeout_ms`) so token retrieval won’t hang and blow overall SLA.
- Your provider must:
  - propagate this `signal` to network calls (fetch/gRPC/HTTP);
  - abort quickly when `signal.aborted` (typically throwing an `AbortError`).
- This enables correct retries and graceful degradation.

Example:

```ts
class MyCredentialsProvider extends CredentialsProvider {
  #token: string | null = null

  async getToken(
    force = false,
    signal: AbortSignal = AbortSignal.timeout(10_000)
  ) {
    if (!force && this.#token) return this.#token
    const abort = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const res = await fetch(this.#endpoint, {
      method: 'POST',
      body: '{}',
      signal: abort,
    })
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`)
    const { token } = await res.json()
    this.#token = token
    return token
  }
}
```

## Low-level service clients

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

const discovery = driver.createClient(DiscoveryServiceDefinition)
const endpoints = await discovery.listEndpoints({ database: driver.database })
```

See also “Advanced → Low-level clients (driver)”.
