---
title: Low-level clients (driver)
---

# Low-level clients

Use `driver.createClient(ServiceDefinition)` to access any YDB gRPC service from `@ydbjs/api/*`.

Example:

```ts
import { Driver } from '@ydbjs/core'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

const driver = new Driver(process.env.YDB_CONNECTION_STRING!)
await driver.ready()

const discovery = driver.createClient(DiscoveryServiceDefinition)
const res = await discovery.listEndpoints({ database: driver.database })
```

For more examples, see package docs in `packages/api`.
