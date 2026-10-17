# @ydbjs/api

The `@ydbjs/api` package provides TypeScript/JavaScript bindings for interacting with YDB services. It includes generated gRPC service definitions and protocol buffer types for various YDB APIs.

## Features

- gRPC service definitions for YDB APIs
- Protocol buffer types for YDB entities
- TypeScript support with type definitions

## Installation

Install the package using npm:

```sh
npm install @ydbjs/api
```

## Usage

### Importing Services

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { CmsServiceDefinition } from '@ydbjs/api/cms'
import { QueryServiceDefinition } from '@ydbjs/api/query'
import { PileState, PileState_State } from '@ydbjs/api/bridge' // bridge / multi-pile (2-DC) clusters
```

### Using with @ydbjs/core

Driver takes the database from the connection string and adds database and authentication metadata to each call.

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { Driver } from '@ydbjs/core'

using driver = new Driver('grpc://localhost:2136/local')
let signal = AbortSignal.timeout(5000)
await driver.ready(signal)
let client = driver.createClient(DiscoveryServiceDefinition)

let response = await client.listEndpoints({ database: driver.database }, { signal })
console.log(response)
```

### Using the standalone transport

Pass a generated service definition and a transport to `createServiceClient(service, transport)` from `@ydbjs/grpc` for direct gRPC access. The transport connects to one authority; Driver supplies YDB discovery, authentication, database metadata, and node selection.

Unary and client-streaming methods return `Promise<Response>`. Server-streaming and bidirectional methods return `AsyncIterable<Response>`. See [`@ydbjs/grpc`](../grpc/README.md) for cancellation, metadata, and connection options.

## Development

### Generating gRPC and Protocol Buffer Files

```sh
npm run generate
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
