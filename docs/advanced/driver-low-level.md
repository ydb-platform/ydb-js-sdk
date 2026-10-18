---
title: Low-level clients (driver)
---

# Low-level clients

Use `driver.createClient(ServiceDefinition)` to access any YDB gRPC service from `@ydbjs/api/*`.

Example:

```ts
import { Driver } from '@ydbjs/core'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

let discovery = driver.createClient(DiscoveryServiceDefinition)
let response = await discovery.listEndpoints({ database: driver.database })
console.log(response)
```

For more examples, see package docs in `packages/api`.
