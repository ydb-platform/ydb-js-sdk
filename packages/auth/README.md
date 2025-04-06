# @ydbjs/auth

The `@ydbjs/auth` package provides authentication utilities for interacting with YDB services. It supports various authentication mechanisms, including static credentials, anonymous access, and token-based authentication.

## Features

- 🔒 Static credentials support
- 🔑 Token-based authentication
- 🕶️ Anonymous access for development and testing
- ✅ TypeScript support with type definitions

## Installation

```sh
npm install @ydbjs/auth
```

## Usage

### Static Credentials

```ts
import { StaticCredentialsProvider } from '@ydbjs/auth';

const provider = new StaticCredentialsProvider({
    user: 'username',
    password: 'password',
});
```

### Token-Based Authentication

```ts
import { AccessTokenCredentialsProvider } from '@ydbjs/auth';

const provider = new AccessTokenCredentialsProvider({
    token: 'your-access-token',
});
```

### Anonymous Access

```ts
import { AnonymousCredentialsProvider } from '@ydbjs/auth';

const provider = new AnonymousCredentialsProvider();
```

## API Reference

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

### `AnonymousCredentialsProvider`

- **Constructor**: `new AnonymousCredentialsProvider()`

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
