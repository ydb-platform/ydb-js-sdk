# @ydbjs/query

The `@ydbjs/query` package provides a high-level, type-safe client for executing YQL queries and managing transactions in YDB. It features a tagged template API, automatic parameter binding, transaction helpers, and deep integration with the YDB type system.

## Features

- Tagged template syntax for YQL queries
- Type-safe, automatic parameter binding (including complex/nested types)
- Transaction helpers with isolation and idempotency options
- Multiple result sets and streaming support
- Query statistics and diagnostics
- Full TypeScript support

## Installation

```sh
npm install @ydbjs/core@alpha @ydbjs/query@alpha
```

## How It Works

- **Query Client**: Create a query client with `query(driver)`. This provides a tagged template function for YQL queries and helpers for transactions.
- **Sessions & Transactions**: Sessions and transactions are managed automatically. You can run single queries or group multiple queries in a transaction with `begin`/`transaction`.
- **Parameter Binding**: Parameters are bound by interpolation (`${}`) in the template string. Native JS types, YDB value classes, and arrays/objects are all supported. Use `.parameter()`/`.param()` for named parameters.
- **Type Safety**: All values are converted using `@ydbjs/value` (see its docs for details). Complex/nested types and arrays are handled automatically.
- **Result Sets**: Most queries return an array of result sets (YDB supports multiple result sets per query).
- **Query Statistics**: Use `.withStats()` or `.stats()` to access execution statistics.

## Usage

### Quick Start

```ts
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';

const driver = new Driver('grpc://localhost:2136/local');
await driver.ready();

const sql = query(driver);
const resultSets = await sql`SELECT 1 + 1 AS sum`;
console.log(resultSets); // [ [ { sum: 2 } ] ]
```

### Parameterized Queries

```ts
const userId = 42n;
const userName = "Alice";
await sql`
  SELECT * FROM users
  WHERE id = ${userId} AND name = ${userName}
`;
```

#### Named Parameters and Custom Types

```ts
import { Uint64 } from '@ydbjs/value/primitive';
const id = new Uint64(123n);
await sql`SELECT * FROM users WHERE id = $id`
  .parameter('id', id);
```

#### Arrays, Structs, and Table Parameters

```ts
const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
];
await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`;
```

### Transactions

```ts
// Serializable read-write transaction (default)
const result = await sql.begin(async (tx) => {
  await tx`UPDATE users SET active = false WHERE last_login < CurrentUtcTimestamp() - Interval('P1Y')`;
  return await tx`SELECT * FROM users WHERE active = false`;
});

// With isolation and idempotency options
await sql.begin({ isolation: 'snapshotReadOnly', idempotent: true }, async (tx) => {
  return await tx`SELECT COUNT(*) FROM users`;
});
```

### Advanced: Multiple Result Sets, Streaming, and Events

```ts
// Multiple result sets
type Result = [[{ id: number }], [{ count: number }]];
const [rows, [{ count }]] = await sql<Result>`SELECT id FROM users; SELECT COUNT(*) as count FROM users;`;

// Listen for query statistics and retries
const q = sql`SELECT * FROM users`.withStats('FULL');
q.on('stats', (stats) => console.log('Query stats:', stats));
q.on('retry', (ctx) => console.log('Retrying:', ctx));
await q;
```

### Error Handling

```ts
import { YDBError } from '@ydbjs/error';
try {
  await sql`SELECT * FROM non_existent_table`;
} catch (e) {
  if (e instanceof YDBError) {
    console.error('YDB Error:', e.message);
  }
}
```

### Query Options and Chaining

```ts
await sql`SELECT * FROM users`
  .isolation('onlineReadOnly', { allowInconsistentReads: true })
  .idempotent(true)
  .timeout(5000)
  .withStats('FULL');
```

### Value Conversion and Type Safety

All parameter values are converted using `@ydbjs/value`. See its documentation for details on supported types and conversion rules. You can pass native JS types, or use explicit YDB value classes for full control.

```ts
import { fromJs } from '@ydbjs/value';
await sql`SELECT * FROM users WHERE meta = ${fromJs({ foo: 'bar' })}`;
```

## Query Statistics

You can enable and access query execution statistics:

```ts
const q = sql`SELECT * FROM users`.withStats('FULL');
await q;
console.log(q.stats());
```

## Development

### Building the Package

```sh
npm run build
```

### Running Tests

```sh
npm test
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
