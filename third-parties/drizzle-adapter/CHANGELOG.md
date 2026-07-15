# @ydbjs/drizzle-adapter

## 0.1.2

### Patch Changes

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338), [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8)]:
  - @ydbjs/api@7.0.0
  - @ydbjs/core@7.0.0
  - @ydbjs/query@6.3.1
  - @ydbjs/value@6.0.9

## 0.1.1

### Patch Changes

- [#617](https://github.com/ydb-platform/ydb-js-sdk/pull/617) [`3a661c5`](https://github.com/ydb-platform/ydb-js-sdk/commit/3a661c5e1803fb89a604a5332e142990558c7691) Thanks [@polRk](https://github.com/polRk)! - Advertise the adapter in `x-ydb-sdk-build-info`. `YdbDriver` now registers `@ydbjs/drizzle-adapter/<version>` on the underlying `Driver` for both owned and borrowed instances, so server-side telemetry can attribute traffic to the adapter without losing the native SDK identity (which stays first in the header).

- Updated dependencies [[`3a661c5`](https://github.com/ydb-platform/ydb-js-sdk/commit/3a661c5e1803fb89a604a5332e142990558c7691)]:
  - @ydbjs/core@6.3.0

## 0.1.0

### Minor Changes

- [#613](https://github.com/ydb-platform/ydb-js-sdk/pull/613) [`d79777f`](https://github.com/ydb-platform/ydb-js-sdk/commit/d79777fa94da0341582796b677a93bcee0ccf0b2) Thanks [@polRk](https://github.com/polRk)! - Initial release of `@ydbjs/drizzle-adapter` — a YDB adapter for [Drizzle ORM](https://orm.drizzle.team).

  Originally authored by [@scarlettnik](https://github.com/scarlettnik); rebased and polished for the 0.1.0 release.
  - `createDrizzle(...)` / `drizzle(...)` entry points (connection string, existing `Driver`, custom executor, or remote callback)
  - `ydbTable()` schema builder with YDB-specific column types, indexes, primary keys, unique constraints, table options, TTL, column families, partitioning
  - Full query builder surface: `select`, `insert`, `upsert`, `update`, `delete`, returning, joins, CTE, set operators, relational `db.query.*`, `$count`
  - `migrate()` — inline migrations and Drizzle migration folders, with a transactional migration lock (lease + heartbeat) and recovery modes
  - DDL builders for tables, views, topics, async replication, transfers, users, groups, grants, and `ALTER TABLE`
  - YQL helpers: `pragma`, `yqlScript`, KNN distances/similarities, window/grouping helpers, `valuesTable`, etc.
  - Error mapping to typed `YdbQueryExecutionError` subclasses (authentication, cancelled, overloaded, retryable, timeout, unavailable, unique-constraint)
  - `check:surface` script that locks the published runtime/type surface
