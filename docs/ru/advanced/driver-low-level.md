---
title: Низкоуровневые клиенты (driver)
---

# Низкоуровневые клиенты

Используйте `driver.createClient(ServiceDefinition)` для доступа к любому gRPC‑сервису YDB из `@ydbjs/api/*`.

Пример:

```ts
import { Driver } from '@ydbjs/core'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

const driver = new Driver(process.env.YDB_CONNECTION_STRING!)
await driver.ready()

const discovery = driver.createClient(DiscoveryServiceDefinition)
const res = await discovery.listEndpoints({ database: driver.database })
```
