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
let fromString = new YdbDriver('grpc://localhost:2136/local')

// 2. From an existing SDK Driver instance
using sdkDriver = new Driver('grpc://localhost:2136/local')
let driver = new YdbDriver(sdkDriver)
```

**Note:** If `YdbDriver` creates the SDK driver (via connection string), it owns it and will close it when `driver.close()` is called.

### Key Methods

- `await driver.ready(signal?)`: Ensures the driver is connected and ready.
- `await driver.execute(yql, params, method, options?)`: Low-level YQL execution.
- `await driver.transaction(callback, config?)`: Low-level transactional execution.
- `driver.close()`: Releases driver resources. Synchronous; returns `void`.

## YdbSession

`YdbSession` represents a single database session context. It acts as the bridge between the driver, dialect, and logger.

### Key Methods

- `.all()`, `.get()`, `.values()`, `.execute()`: Execute single queries in different formats.
- `.prepareQuery(...)`: Internal method used by the public query builder’s `.prepare()`.
- `.batch([queries])`: Executes multiple queries sequentially; this alone does not create a transaction or pin a server session.
- `.count(query)`: Efficiently returns the row count.
- `.transaction(callback)`: Starts a transactional session.

### YdbPreparedQuery

`.prepare()` creates a reusable query object containing the rendered YQL and values already supplied to the builder. Its execution methods accept no parameters; build another query to use different values. Named placeholders and server-side prepared statements are not supported.

The optional name accepted by `prepare(name?)` is currently ignored.

```ts
import { eq } from 'drizzle-orm'

let prepared = db.select().from(users).where(eq(users.id, 1)).prepare()

await prepared.execute()
```

## YdbDialect

`YdbDialect` is responsible for transforming Drizzle's abstract query structures into YQL syntax and handling type mapping.

### Features

- **Escaping:** Methods like `escapeName()`, `escapeParam()`, and `escapeString()` for safe SQL generation.
- **Rendering:** Low-level methods (`buildSelectQuery`, `buildInsertQuery`, etc.) used by query builders.
- **Migrations:** Handles low-level migration logic, including history table management and hash validation.

### Query rendering

`YdbDialect.sqlToQuery()` renders SQL internally. Applications use `.toSQL()` on a builder:

```ts
import { eq } from 'drizzle-orm'

let { sql: query, params } = db.select().from(users).where(eq(users.id, 1)).toSQL()
```
