# @ydbjs/auth

The `@ydbjs/auth` package provides authentication utilities for interacting with YDB services. It supports various authentication mechanisms, including static credentials, anonymous access, and token-based authentication.

## Features

- 🔒 Static credentials support
- 🔑 Token-based authentication
- 🕶️ Anonymous access for development and testing
- ✅ TypeScript support with type definitions

## Installation

```sh
npm install @ydbjs/auth@6.0.0-alpha.2
```

## Usage

### Anonymous Access

```ts
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';

const provider = new AnonymousCredentialsProvider();
```

### Static Credentials

```ts
import { StaticCredentialsProvider } from '@ydbjs/auth/static';

const provider = new StaticCredentialsProvider({
    user: 'username',
    password: 'password',
});
```

### Token-Based Authentication

```ts
import { AccessTokenCredentialsProvider } from '@ydbjs/auth/access-token';

const provider = new AccessTokenCredentialsProvider({
    token: 'your-access-token',
});
```

### VM Metadata Authentication
[GoogleCloud](https://cloud.google.com/compute/docs/metadata/querying-metadata), [YandexCloud](https://yandex.cloud/ru/docs/compute/operations/vm-info/get-info)

```ts
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';

const provider = new MetadataCredentialsProvider();
```

## API Reference

### `AnonymousCredentialsProvider`

- **Constructor**: `new AnonymousCredentialsProvider()`

### `StaticCredentialsProvider`

- **Constructor**: `new StaticCredentialsProvider(credendials: { user: string; password: string }, endpoint: string)`
- **Credentials**:
    - `user`: The username for authentication.
    - `password`: The password for authentication.
- **Endpoint**: The endpoint for the YDB service.
- **ClientFactory**: A factory function to create a gRPC client instance.

### `AccessTokenCredentialsProvider`

- **Constructor**: `new AccessTokenCredentialsProvider(credendials: { token: string })`
- **Credentials**:
    - `token`: The access token.

### `MetadataCredentialsProvider`

- **Constructor**: `new MetadataCredentialsProvider()`
- **Credentials**:
    - `endpoint`: The endpoint for the VM metadta service.
    - `falvor`: The falvor of the metadata service. Typically `Google`.

## Development

To build the package:

```sh
npm run build
```

To run tests:

```sh
npm test
```

## License

This project is licensed under the [Apache 2.0 License](https://www.apache.org/licenses/LICENSE-2.0).
