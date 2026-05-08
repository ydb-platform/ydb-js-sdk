---
title: Drizzle Adapter — Options and API
---

# Options and API `@ydbjs/drizzle-adapter`

Below is a comprehensive overview of the adapter configuration, runtime methods, and chainable options.

## Client and Basic Syntax

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

let db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
  schema,
  logger: true,
})
```

Client options:

- `connectionString`: creates an owned `YdbDriver` from a connection string.
- `client`: existing `YdbExecutor` or `YdbTransactionalExecutor`.
- `schema`: enables typed Relational Query API (`db.query.*`).
- `logger`: `true`, `false`, or a custom Drizzle `Logger`.
- `casing`: Drizzle casing mode (`'snake_case'` or `'camelCase'`) passed to the dialect.

Alternative entry points:

- `createDrizzle(executor, config?)`: use an existing executor.
- `createDrizzle(callback, config?)`: use a remote callback executor (Proxy mode).
- `drizzle(...)`: an alias for `createDrizzle(...)`.

## Database Methods

- `execute(query)`: executes a query and returns the typed result.
- `all(query)`: returns all rows as objects.
- `get(query)`: returns the first row or `undefined`.
- `values(query)`: returns rows as arrays of values.
- `transaction(callback, config?)`: runs the callback in a YDB transaction.
- `$count(source, filters?)`: awaitable helper for efficient row counting.
- `$client`: underlying executor; use `ready?.()` and `close?.()` for lifecycle management.

Transaction options:

- `accessMode`: `'read write' | 'read only'`.
- `isolationLevel`: `'serializableReadWrite' | 'snapshotReadOnly'`.
- `idempotent`: if `true`, allows automatic retries for the transaction on network errors.

## Schema Options

- `ydbTable(name, columns, extraConfig?)`: declares a table.
- `ydbTableCreator(customizeTableName)`: table factory with name mapping.
- `primaryKey({ columns })`: composite primary key.
- `unique(name?).on(...columns)`: unique constraint.
- `index(name?).on(...columns)`: secondary index.
- `uniqueIndex(name?).on(...columns)`: unique secondary index.
- `vectorIndex(name, options).on(column)`: vector index.
- `tableOptions(options)`: raw YDB table options.
- `ttl(column, intervalOrActions, options?)`: TTL (Time to Live) configuration.
- `partitionByHash(...columns)`: hash partitioning.
- `columnFamily(name, options?).columns(...columns)`: column families.

Index builder options:

- `.global()` / `.local()`: locality.
- `.sync()` / `.async()`: write synchronization.
- `.using(indexType)`: custom index type.
- `.vectorKMeansTree(options)`: vector k-means tree index type.
- `.cover(...columns)`: covering columns.
- `.with(options)`: raw index options.

Vector index options:

- `vectorDimension`, `vectorType`, `distance` or `similarity`, `clusters`, `levels`.

## Query Builder Options

SELECT:

- Sources: `.from()`, `.fromAsTable()`, `.fromValues()`.
- Filtering and Grouping: `.where()`, `.having()`, `.groupBy()`, `.groupCompactBy()`.
- Sorting and Limits: `.orderBy()`, `.assumeOrderBy()`, `.limit()`, `.offset()`.
- YDB Extensions: `.without()`, `.flattenBy()`, `.flattenListBy()`, `.flattenDictBy()`, `.flattenOptionalBy()`, `.flattenColumns()`, `.sample()`, `.tableSample()`, `.matchRecognize()`, `.window()`, `.intoResult()`.
- Distinct and Set Operations: `.distinct()`, `.distinctOn()`, `.uniqueDistinct()`, `.union()`, `.unionAll()`, `.intersect()`, `.except()`.
- Execution and rendering: `.getSQL()`, `.toSQL()`, `.execute()`, `.prepare()`. Prepared queries expose `.all()`, `.get()`, and `.values()`.

Mutations:

- Insert-like builders: `.values()`, `.select()`, `.onDuplicateKeyUpdate()`, `.returning()`.
- Update builders: `.set()`, `.where()`, `.on()`, `.returning()`.
- Delete builders: `.where()`, `.using()`, `.on()`, `.returning()`.
- Batch builders: `batchUpdate` and `batchDelete` support `.where()` but reject `returning()` and `on()`.

## Relational Query Options

Use `db.query.<table>.findFirst(config?)` and `db.query.<table>.findMany(config?)` when `schema` is provided.

- `columns`: include or exclude specific table columns.
- `where`: filter logic callback.
- `orderBy`: sort expressions callback.
- `limit` and `offset`: pagination controls.
- `with`: nested relation loading.
- `extras`: additional SQL selections.

## Migration Options

- `migrationsFolder`: Drizzle migrations folder path.
- `migrations`: inline migration objects.
- `migrationsTable`: history table name.
- `migrationsSchema`: schema or folder prefix for history tables.
- `migrationsLockTable`: lock table name.
- `migrationLock`: `true`, `false`, or lock options.
- `migrationRecovery`: recovery options.

Lock options:

- `key`, `ownerId`, `leaseMs`, `acquireTimeoutMs`, `retryIntervalMs`.

Recovery options:

- `mode`: `'fail' | 'retry'`.
- `staleRunningAfterMs`: threshold for stale running migration.

## YQL Helper Options

- `valuesTable(rows, { alias?, columns? })`: inline source.
- `windowDefinition({ partitionBy?, orderBy?, frame? })`: window configuration.
- `matchRecognize({ partitionBy?, orderBy?, measures?, rowsPerMatch?, afterMatchSkip?, pattern, define? })`: event pattern matching.
- `pragma(name, value?)`, `declareParam(name, dataType)`, `defineAction(name, params, statements)`, `doAction(name, args?)`: YQL script helpers.
- `kMeansTreeSearchTopSize(value)`: vector search pragma helper.

## Limitations

- The adapter is ESM-only, matching the rest of the YDB JavaScript SDK packages.
- Nested YDB transactions are not supported. Create one transaction boundary and pass the transaction object to lower-level functions.
- YDB supports the adapter transaction modes `serializableReadWrite` and `snapshotReadOnly`; unsupported isolation levels are not emulated.
- `references()` is relation metadata only. YDB does not enforce foreign keys.
- Unique indexes must be created with table DDL; adding a unique index to an existing table is rejected.
- Raw helpers (`sql.raw`, inline migration `sql`, `rawTableOption`, view query text, raw ACL permissions, transfer `using`) intentionally bypass escaping and must not receive untrusted input.
