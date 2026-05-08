---
title: Drizzle Adapter — Driver, Session, Dialect
---

# Internals: Driver, Session, Dialect

Understanding the low-level components of the YDB Drizzle adapter: `YdbDriver`, `YdbSession`, and `YdbDialect`.

Only `YdbDriver` is a root runtime export. `YdbSession` and `YdbDialect` are implementation details used by the adapter and are documented here to explain behavior, not as stable application-level constructors.

## YdbDriver

`YdbDriver` is the low-level component that facilitates communication between Drizzle ORM and the `@ydbjs/core` driver.

### Initialization

```ts
import { Driver } from '@ydbjs/core'
import { YdbDriver } from '@ydbjs/drizzle-adapter'

// 1. From connection string
const fromString = new YdbDriver('grpc://localhost:2136/local')

// 2. From an existing SDK Driver instance
const sdkDriver = new Driver({
  /* ... */
})
const driver = new YdbDriver(sdkDriver)
```

**Note:** If `YdbDriver` creates the SDK driver (via connection string), it owns it and will close it when `driver.close()` is called.

### Key Methods

- `await driver.ready(signal?)`: Ensures the driver is connected and ready.
- `await driver.execute(yql, params, method, options?)`: Low-level YQL execution.
- `await driver.transaction(callback, config?)`: Low-level transactional execution.
- `await driver.close()`: Releases driver resources.

## YdbSession

`YdbSession` represents a single database session context. It acts as the bridge between the driver, dialect, and logger.

### Key Methods

- `.all()`, `.get()`, `.values()`, `.execute()`: Execute single queries in different formats.
- `.prepareQuery(sql, fields, name, arrayMode)`: Creates a `YdbPreparedQuery` for reuse.
- `.batch([queries])`: Executes multiple queries sequentially in one session.
- `.count(query)`: Efficiently returns the row count.
- `.transaction(callback)`: Starts a transactional session.

### YdbPreparedQuery

Returned by `.prepare()`, this object allows executing the same query with different parameters without re-parsing the SQL.

```ts
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
const { sql, params } = dialect.sqlToQuery(sql`SELECT * FROM users WHERE id = ${1}`)
// Result -> sql: "SELECT * FROM users WHERE id = $p0", params: [1]
```
