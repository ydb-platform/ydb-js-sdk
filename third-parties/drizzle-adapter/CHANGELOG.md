# @ydbjs/drizzle-adapter

## 0.1.2

### Patch Changes

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`cdff086`](https://github.com/ydb-platform/ydb-js-sdk/commit/cdff0864d850ba1bd1c7cf7c7041dd9742f04ef6), [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a), [`64df3b5`](https://github.com/ydb-platform/ydb-js-sdk/commit/64df3b50005490e7c5a1628a6a9f31cb19e07d3d), [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338), [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8), [`e6960f6`](https://github.com/ydb-platform/ydb-js-sdk/commit/e6960f6b4170c7d399739b364c45ed5ca8374eb4), [`549da21`](https://github.com/ydb-platform/ydb-js-sdk/commit/549da21a2f16312e5c774cb34ab4de87f40f3005), [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096), [`4f76c1e`](https://github.com/ydb-platform/ydb-js-sdk/commit/4f76c1e760106f5305f9eddd2db5322e172214b7), [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28), [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1), [`6ad8ff0`](https://github.com/ydb-platform/ydb-js-sdk/commit/6ad8ff016a40d9036add4d7db8dc5d0e6b8365de)]:
  - @ydbjs/api@7.0.0
  - @ydbjs/core@7.0.0
  - @ydbjs/query@7.0.0
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
