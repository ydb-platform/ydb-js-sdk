---
title: Drizzle Adapter — Driver, Session, Dialect
---

# Internals: Driver, Session, Dialect

Understanding the low-level components of the YDB Drizzle adapter: `YdbDriver`, `YdbSession`, and `YdbDialect`.

Only `YdbDriver` is a root runtime export. `YdbSession` and `YdbDialect` are implementation details used by the adapter and are documented here to explain behavior, not as stable application-level constructors.

## YdbDriver

`YdbDriver` passes YQL text and named parameters to `QueryClient` from `@ydbjs/query`. A standalone statement runs in `retrySession()`, and a transaction runs in `retryTransaction()`.

Each standalone attempt reads the current parameter types and values. Changes to a buffer, a typed value, or the parameter array between attempts affect the retried request. Keep the inputs unchanged until the operation finishes if every attempt must use identical values.

A transaction retry runs the callback again, including construction of its statements and parameters. If all attempts must use the same inputs, capture those inputs before entering the callback and keep mutable values unchanged until the transaction finishes.

### Initialization

```ts
import { Driver } from '@ydbjs/core'
import { YdbDriver } from '@ydbjs/drizzle-adapter'

// 1. From connection string
let fromString = new YdbDriver('grpc://localhost:2136/local')

// 2. From an existing SDK Driver instance
let sdkDriver = new Driver('grpc://localhost:2136/local')
let driver = new YdbDriver(sdkDriver)
```

`driver.close()` releases the pool and driver created by the adapter. With `new YdbDriver(client)`, the application owns both the supplied `QueryClient` and its driver.

### Key Methods

- `await driver.ready(signal?)`: Ensures the driver is connected and ready.
- `await driver.execute(yql, params, method, options?)`: Low-level YQL execution.
- `await driver.transaction(callback, config?)`: Low-level transactional execution.
- `driver.close()`: Releases driver resources. Synchronous; returns `void`.

## YdbSession

`YdbSession` prepares Drizzle queries, logs them, and maps executor results to the selected fields. The native query client acquires a YDB session for each standalone operation or transaction attempt.

### Key Methods

- `.all()`, `.get()`, `.values()`, `.execute()`: Execute single queries in different formats.
- `.prepareQuery(sql, fields, name, arrayMode)`: Creates a `YdbPreparedQuery` for reuse.
- `.batch([queries])`: Executes the queries sequentially. Inside a transaction they share its session.
- `.count(query)`: Efficiently returns the row count.
- `.transaction(callback)`: Starts a transactional session.

### YdbPreparedQuery

Returned by `.prepare()`, this object allows executing the same query with different parameters without re-parsing the SQL.

```ts
import { sql } from 'drizzle-orm'

// `session` is obtained from a YdbDriver call site (e.g. inside `db.transaction`).
const prepared = session.prepareQuery(
  sql`SELECT * FROM users WHERE id = ${sql.placeholder('id')}`,
  undefined,
  'select_user'
)

await prepared.execute({ id: 1 })
```

## YdbDialect

`YdbDialect` is responsible for transforming Drizzle's abstract query structures into YQL syntax and handling type mapping.

### Features

- **Escaping:** Methods like `escapeName()`, `escapeParam()`, and `escapeString()` for safe SQL generation.
- **Rendering:** Low-level methods (`buildSelectQuery`, `buildInsertQuery`, etc.) used by query builders.
- **Migrations:** Handles low-level migration logic, including history table management and hash validation.

### sqlToQuery

Transforms a Drizzle `sql` template into YQL with parameter placeholders.

```ts
import { sql } from 'drizzle-orm'

const dialect = new YdbDialect()
const { sql: query, params } = dialect.sqlToQuery(sql`SELECT * FROM users WHERE id = ${1}`)
// query  -> "SELECT * FROM users WHERE id = $p0"
// params -> [1]
```
