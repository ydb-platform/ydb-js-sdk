---
title: Низкоуровневые клиенты (driver)
---

# Низкоуровневые клиенты

Используйте `driver.createClient(ServiceDefinition)` для доступа к любому gRPC‑сервису YDB из `@ydbjs/api/*`.

Пример:

```ts
import { Driver } from '@ydbjs/core'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

let discovery = driver.createClient(DiscoveryServiceDefinition)
let response = await discovery.listEndpoints({ database: driver.database })
console.log(response)
```
