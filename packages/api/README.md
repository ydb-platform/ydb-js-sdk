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

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'
import { Driver } from '@ydbjs/core'

let driver = new Driver('grpc://localhost:2136/local')
await driver.ready()
let client = driver.createClient(DiscoveryServiceDefinition)

let response = await client.listEndpoints({ database: driver.database })
console.log(response)
driver.close()
```

### Using with grpc-js

```ts
import { Client, credentials, Metadata } from '@grpc/grpc-js'
import { createServiceClient } from '@ydbjs/api/client'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

let nativeClient = new Client('localhost:2136', credentials.createInsecure())
let client = createServiceClient(DiscoveryServiceDefinition, nativeClient)
let metadata = new Metadata()
metadata.set('x-ydb-database', '/local')

try {
  let response = await client.listEndpoints(
    { database: '/local' },
    {
      metadata,
      signal: AbortSignal.timeout(5000),
    }
  )
  console.log(response)
} finally {
  client.close()
}
```

Unary and client-streaming methods return `Promise<Response>`. Server-streaming and bidirectional methods return `AsyncIterable<Response>` and start when iteration begins. Request streams accept `AsyncIterable<Request>`; writes respect grpc-js backpressure. Breaking out of response iteration cancels the RPC. Finishing a request stream half-closes it and allows the server to send its remaining responses.

`ClientCallOptions` extends grpc-js `CallOptions` with `metadata`, `signal`, `onHeader`, and `onTrailer`. Metadata, credentials, interceptors, and server errors use native grpc-js types. Cancellation rejects with `signal.reason` before another buffered response is delivered; request-producer failures retain their original error. Producers that wait for external input must also release that input when cancelled: the adapter requests iterator cleanup without waiting indefinitely for a blocked `next()`.

`ServiceClient<Service>` infers methods from the native grpc-js `ServiceDefinition` and exposes `close()` for the underlying native client. The definitions also work directly with grpc-js `makeClientConstructor`. RPC failures preserve the native `ServiceError`, including its status code, details, and trailing metadata.

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
