# @ydbjs/api

The `@ydbjs/api` package provides TypeScript/JavaScript bindings for interacting with YDB services. It includes generated gRPC service definitions and protocol buffer types for various YDB APIs.

## Features

- gRPC service definitions for YDB APIs
- Protocol buffer types for YDB entities
- TypeScript support with type definitions

## Installation

Install the package using npm:

```sh
npm install @ydbjs/api@alpha
```

## Usage

### Importing Services

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery';
import { CmsServiceDefinition } from '@ydbjs/api/cms';
import { QueryServiceDefinition } from '@ydbjs/api/query';
```

### Example: Using a Service

```ts
import { createClientFactory, createChannel } from 'nice-grpc';
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery';

const clientFactory = createClientFactory();
const discoveryClient = clientFactory.create(DiscoveryServiceDefinition, createChannel('http://localhost:2136'));

async function listEndpoints() {
  const response = await discoveryClient.listEndpoints({ database: '/local' });
  console.log(response);
}

listEndpoints().catch(console.error);
```

### Using with @ydbjs/core

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery';
import { Driver } from '@ydbjs/core';

const driver = new Driver('grpc://localhost:2136');
const client = driver.createClient(DiscoveryServiceDefinition);
client.listEndpoints({ database: '/local' });
```

## Development

### Generating gRPC and Protocol Buffer Files

```sh
npm run generate
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
