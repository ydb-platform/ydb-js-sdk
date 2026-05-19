---
'@ydbjs/drizzle-adapter': major
---

Initial release of `@ydbjs/drizzle-adapter` — a YDB adapter for [Drizzle ORM](https://orm.drizzle.team).

- `createDrizzle(...)` / `drizzle(...)` entry points (connection string, existing `Driver`, custom executor, or remote callback)
- `ydbTable()` schema builder with YDB-specific column types, indexes, primary keys, unique constraints, table options, TTL, column families, partitioning
- Full query builder surface: `select`, `insert`, `upsert`, `update`, `delete`, returning, joins, CTE, set operators, relational `db.query.*`, `$count`
- `migrate()` — inline migrations and Drizzle migration folders, with a transactional migration lock (lease + heartbeat) and recovery modes
- DDL builders for tables, views, topics, async replication, transfers, users, groups, grants, and `ALTER TABLE`
- YQL helpers: `pragma`, `yqlScript`, KNN distances/similarities, window/grouping helpers, `valuesTable`, etc.
- Error mapping to typed `YdbQueryExecutionError` subclasses (authentication, cancelled, overloaded, retryable, timeout, unavailable, unique-constraint)
- `check:surface` script that locks the published runtime/type surface
