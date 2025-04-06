# @ydbjs/api

The `@ydbjs/api` package provides TypeScript/JavaScript bindings for interacting with YDB services. It includes generated gRPC service definitions and protocol buffer types for various YDB APIs.

## Installation

```sh
npm install @ydbjs/api@6.0.0-alpha.2
```

## Features

- gRPC service definitions for YDB APIs.
- Protocol buffer types for YDB entities.
- TypeScript support with type definitions.

## Usage

### Importing Services

You can import specific YDB services and their types from the package:

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery';
import { CmsServiceDefinition } from '@ydbjs/api/cms';
import { QueryServiceDefinition } from '@ydbjs/api/query';
```

### Example: Using a Service

Here is an example of using the `DiscoveryService` to list endpoints:

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

Here is example of using the `DiscoveryService` with `@ydbjs/core.Driver`:

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery';
import { Driver } from "@ydbjs/core";

let driver = new Driver("grpc://localhost:2136");
let client = driver.createClient(DiscoveryServiceDefinition);

client.listEndpoints({ database: '/local' });
```

### Available Services

The following services are available in the `@ydbjs/api` package:

- **Auth Service**: `@ydbjs/api/auth`
- **CMS Service**: `@ydbjs/api/cms`
- **Coordination Service**: `@ydbjs/api/coordination`
- **Discovery Service**: `@ydbjs/api/discovery`
- **Export Service**: `@ydbjs/api/export`
- **Federation Discovery Service**: `@ydbjs/api/federation-discovery`
- **Import Service**: `@ydbjs/api/import`
- **Monitoring Service**: `@ydbjs/api/monitoring`
- **Operation Service**: `@ydbjs/api/operation`
- **Query Service**: `@ydbjs/api/query`
- **Rate Limiter Service**: `@ydbjs/api/rate-limiter`
- **Scheme Service**: `@ydbjs/api/scheme`
- **Scripting Service**: `@ydbjs/api/scripting`
- **Table Service**: `@ydbjs/api/table`
- **Topic Service**: `@ydbjs/api/topic`

### Generated Types

The package also includes generated protocol buffer types for working with YDB entities. For example:

```ts
import { EndpointInfo } from '@ydbjs/api/discovery';

const endpoint: EndpointInfo = {
    address: 'localhost',
    port: 2136,
};
```

## Development

To regenerate the gRPC and protocol buffer files, run:

```sh
npm run generate
```

This uses the `buf` tool to generate TypeScript files from the YDB API protocol buffer definitions.

For more details, refer to the [YDB documentation](https://ydb.tech).
