# @ydbjs/auth

The `@ydbjs/auth` package provides authentication utilities for interacting with YDB services. It supports static credentials, token-based authentication, anonymous access, and VM metadata providers.

## Features

- Static credentials support
- Token-based authentication
- Anonymous access for development and testing
- VM metadata authentication (Google Cloud, Yandex Cloud)
- TypeScript support with type definitions

## Installation

Install the package using npm:

```sh
npm install @ydbjs/auth@6.0.0@alpha
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
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { StaticCredentialsProvider } from '@ydbjs/auth/static';

const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: new StaticCredentialsProvider({
    username: 'username',
    password: 'password',
  }),
});
await driver.ready();

const sql = query(driver);
const result = await sql`SELECT 1`;
```

### Static Credentials (Manual Usage)

```ts
import { StaticCredentialsProvider } from '@ydbjs/auth/static';

const provider = new StaticCredentialsProvider({
  username: 'username',
  password: 'password',
}, 'grpc://localhost:2136/local');

const token = await provider.getToken();
// The token can be used in custom gRPC calls if needed
```

### Token-Based Authentication

```ts
import { AccessTokenCredentialsProvider } from '@ydbjs/auth/access-token';

const provider = new AccessTokenCredentialsProvider({
  token: 'your-access-token',
});

// Use with driver
import { Driver } from '@ydbjs/core';
const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: provider,
});
await driver.ready();
```

### Anonymous Access

```ts
import { Driver } from '@ydbjs/core';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';

const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: new AnonymousCredentialsProvider(),
});
await driver.ready();
```

### VM Metadata Authentication (Cloud)

```ts
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';

const provider = new MetadataCredentialsProvider({
  // Optional: override endpoint or flavor for your cloud
  // endpoint: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
  // flavor: 'Google',
});

import { Driver } from '@ydbjs/core';
const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: provider,
});
await driver.ready();
```

---

## What is Sent to YDB Server

- For **Static Credentials** and **VM Metadata**: The SDK first obtains a token (via login or metadata service), then sends `x-ydb-auth-ticket: <token>` in every gRPC request.
- For **Access Token**: The SDK sends `x-ydb-auth-ticket: <token>` in every gRPC request.
- For **Anonymous**: No authentication header is sent.

You do not need to manually set headers; the SDK handles this for you.

---

## See Also

- [@ydbjs/core](https://www.npmjs.com/package/@ydbjs/core) – YDB driver
- [@ydbjs/query](https://www.npmjs.com/package/@ydbjs/query) – SQL query builder for YDB
- [YDB Documentation](https://ydb.tech/docs/en/)
