---
'@ydbjs/table': minor
'@ydbjs/debug': patch
---

Add new `@ydbjs/table` package with `BulkUpsert` support.

`BulkUpsert` enables high-throughput, non-transactional batch ingestion. The
server splits the request into independent per-partition transactions
executed in parallel, which is significantly faster than YQL-based inserts
for large payloads.

```ts
import { Driver } from '@ydbjs/core'
import { table } from '@ydbjs/table'

let driver = new Driver(connectionString)
await driver.ready()

let client = table(driver)
await client.bulkUpsert('/local/users', [
  { id: 1n, name: 'Neo' },
  { id: 2n, name: 'Trinity' },
])
```

Also registers a new `table` logger category in `@ydbjs/debug`.

Closes [#587](https://github.com/ydb-platform/ydb-js-sdk/issues/587).
