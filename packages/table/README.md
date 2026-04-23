# @ydbjs/table

High-level client for the [YDB](https://ydb.tech) Table service.

This package currently exposes a single operation: **`BulkUpsert`** — an
efficient, non-transactional batch write that the server splits into
independent per-partition transactions executed in parallel. It is the
recommended way to ingest large volumes of data.

`BulkUpsert` guarantees that every row in the request is applied when the
call succeeds. Atomicity across the whole dataset is **not** guaranteed:
on failure some partitions may have been updated while others have not.

## Install

```sh
npm install @ydbjs/core @ydbjs/table
```

## Usage

```ts
import { Driver } from '@ydbjs/core'
import { table } from '@ydbjs/table'

let driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

let client = table(driver)

await client.bulkUpsert('/local/users', [
  { id: 1n, name: 'Neo' },
  { id: 2n, name: 'Trinity' },
])
```

### Precise column types

Passing an array of plain objects infers column types via
[`@ydbjs/value`'s `fromJs`](../value/README.md). If you need explicit control
(for example `Uint64` instead of `Int64`, or optional columns that may be
absent in some rows), build a `List<Struct>` yourself and pass it as `rows`:

```ts
import { List } from '@ydbjs/value/list'
import { Struct } from '@ydbjs/value/struct'
import { Optional } from '@ydbjs/value/optional'
import { Uint64, Text } from '@ydbjs/value/primitive'

let rows = new List(
  new Struct({ id: new Uint64(1n), name: new Optional(new Text('Neo')) }),
  new Struct({ id: new Uint64(2n), name: new Optional(new Text('Trinity')) })
)

await client.bulkUpsert('/local/users', rows)
```

### Options

```ts
await client.bulkUpsert('/local/users', rows, {
  signal: controller.signal, // abort the call
  timeout: 30_000, // operation timeout in ms
  idempotent: true, // retry retryable errors (default: true)
})
```

Because `BulkUpsert` is upsert, replaying a request with the same payload is
safe — retries on retryable errors are enabled by default. Set
`idempotent: false` to disable.

## Requirements

- Node.js >= 20.19
- A reachable YDB cluster

## License

Apache-2.0
