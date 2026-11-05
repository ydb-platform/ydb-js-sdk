# @ydbjs/drizzle-adapter

## 1.0.0

### Major Changes

- [#722](https://github.com/ydb-platform/ydb-js-sdk/pull/722) [`cf9ff57`](https://github.com/ydb-platform/ydb-js-sdk/commit/cf9ff57cc0f8ffb82c42a894f7aba1ee5f09b49a) Thanks [@polRk](https://github.com/polRk)! - Return mapped result rows and nested selection groups as objects with a null prototype. Selected fields named `__proto__`, `constructor`, and `toString` remain own properties. Use `Object.hasOwn(row, name)` instead of inherited methods such as `row.hasOwnProperty(name)`; spread a result into `{ ...row }` when an object with `Object.prototype` is required.

  Ignore inherited properties in object-row lookup and nullable-join metadata while retaining positional fallback for absent fields and preserving own `null` and `undefined` values.

### Patch Changes

- [#726](https://github.com/ydb-platform/ydb-js-sdk/pull/726) [`4b3db40`](https://github.com/ydb-platform/ydb-js-sdk/commit/4b3db408e6875661588f6428ff28f20081c90c34) Thanks [@polRk](https://github.com/polRk)! - Add opt-in Temporal result conversion with toJs(value, { temporal: true }), new QueryClient(driver, { temporal: true }) and query(driver, { temporal: true }). Preserve the default Value/Date representations when the option is disabled.

  Use the application-provided global Temporal implementation. TzDate and TzDate32 remain SDK Values because Temporal has no zoned date-only type. Preserve Drizzle's Date and numeric column representations with Temporal-enabled clients.

- [#738](https://github.com/ydb-platform/ydb-js-sdk/pull/738) [`f6159ec`](https://github.com/ydb-platform/ydb-js-sdk/commit/f6159ecbb40b31b23aef060a2aa608a9bfc7551e) Thanks [@polRk](https://github.com/polRk)! - Infer tagged parameters through fromJs so JSON type-like fields cannot supply SQL declaration syntax. Reject malformed explicit Value bindings before generating declarations. Escape backslashes as well as backticks in quoted identifiers.

  Use default YQL string escaping in Drizzle inline values and DDL builders, and in LangChain filter paths. Preserve backslashes before escaping quotes so data cannot terminate generated SQL literals.

- [#718](https://github.com/ydb-platform/ydb-js-sdk/pull/718) [`ee92bca`](https://github.com/ydb-platform/ydb-js-sdk/commit/ee92bca539ff1e6886ece37722a8c491ee2c2e77) Thanks [@polRk](https://github.com/polRk)! - Export the raw QueryClient class from the package root with retrySession(options, callback) and retryTransaction(options, callback) as its execution entry points. Options may be omitted, but the callback is always last. Each callback receives an executor and the current attempt's cancellation signal; execute() and stream() belong to that executor. The root client has no execute(), do(), transaction() or stream() methods. Retry policy belongs to the callback, while statement signal and timeout options can cap individual operations within the callback budget.

  Rename the callable tagged client type to SQLClient and migrate the Drizzle and LangChain integrations. query(driver) and query(client) provide the convenient tagged API, preserving sql.do(), sql.begin(), sql.transaction(), result shapes and repeat-await behavior over the same execution engine and pool.

  Streaming is available only from executors inside SDK-owned retry callbacks. The SDK owns retry boundaries and revokes streams when their callback ends.

  Keep tagged query bindings stable across retries; raw retry callbacks may build new parameters on each attempt, while each statement snapshots its inputs before consumption. Revoke executors and unfinished streams when their callback ends, and prevent replay after a confirmed commit. Separate stream cancellation from session loss and preserve caller cancellation reasons. Expose beforeCommit for precommit work while retaining onCommit for transactional Topic compatibility.

  Reject commit-hook registration after preparation starts, and observe all started hooks even when another hook throws synchronously.

  Return object rows with null prototypes from execute(), stream() and the tagged SQL facade, including raw-mode rows. Array-mode rows and raw protobuf cells keep their respective representations.

- [#715](https://github.com/ydb-platform/ydb-js-sdk/pull/715) [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b) Thanks [@polRk](https://github.com/polRk)! - Preserve extended temporal values and supported timezone values as SDK Values in default JavaScript results. Keep Date, Datetime and Timestamp results as JavaScript Date and Interval as a number; preserve Drizzle's declared Date and numeric column types.

  Replace date-fns/TZDate with exact Temporal inputs and timezone text. The application supplies globalThis.Temporal; the SDK does not install or register a polyfill. Timezone constructors require Temporal for validation, including string inputs. Reject excess precision, non-ISO calendars, calendar durations and ambiguous local times.

  Require TypeScript 7 or later for the standard Temporal declarations included by the published types.

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`cdff086`](https://github.com/ydb-platform/ydb-js-sdk/commit/cdff0864d850ba1bd1c7cf7c7041dd9742f04ef6), [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a), [`3e75fad`](https://github.com/ydb-platform/ydb-js-sdk/commit/3e75fad0225cc56f7b921577e5d91db426cb6313), [`64df3b5`](https://github.com/ydb-platform/ydb-js-sdk/commit/64df3b50005490e7c5a1628a6a9f31cb19e07d3d), [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338), [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8), [`4b3db40`](https://github.com/ydb-platform/ydb-js-sdk/commit/4b3db408e6875661588f6428ff28f20081c90c34), [`e6960f6`](https://github.com/ydb-platform/ydb-js-sdk/commit/e6960f6b4170c7d399739b364c45ed5ca8374eb4), [`549da21`](https://github.com/ydb-platform/ydb-js-sdk/commit/549da21a2f16312e5c774cb34ab4de87f40f3005), [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096), [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b), [`ee92bca`](https://github.com/ydb-platform/ydb-js-sdk/commit/ee92bca539ff1e6886ece37722a8c491ee2c2e77), [`4f76c1e`](https://github.com/ydb-platform/ydb-js-sdk/commit/4f76c1e760106f5305f9eddd2db5322e172214b7), [`ee92bca`](https://github.com/ydb-platform/ydb-js-sdk/commit/ee92bca539ff1e6886ece37722a8c491ee2c2e77), [`f6159ec`](https://github.com/ydb-platform/ydb-js-sdk/commit/f6159ecbb40b31b23aef060a2aa608a9bfc7551e), [`917508a`](https://github.com/ydb-platform/ydb-js-sdk/commit/917508a6f5a565a996ee966f4c9f4938cbdf5184), [`917508a`](https://github.com/ydb-platform/ydb-js-sdk/commit/917508a6f5a565a996ee966f4c9f4938cbdf5184), [`9d69461`](https://github.com/ydb-platform/ydb-js-sdk/commit/9d69461c6fc1edefb741957a0babe7e2e2626a33), [`ee92bca`](https://github.com/ydb-platform/ydb-js-sdk/commit/ee92bca539ff1e6886ece37722a8c491ee2c2e77), [`ee92bca`](https://github.com/ydb-platform/ydb-js-sdk/commit/ee92bca539ff1e6886ece37722a8c491ee2c2e77), [`ee92bca`](https://github.com/ydb-platform/ydb-js-sdk/commit/ee92bca539ff1e6886ece37722a8c491ee2c2e77), [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28), [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1), [`6ad8ff0`](https://github.com/ydb-platform/ydb-js-sdk/commit/6ad8ff016a40d9036add4d7db8dc5d0e6b8365de), [`c29324d`](https://github.com/ydb-platform/ydb-js-sdk/commit/c29324d4adadf65bd2eb0b6de38672c0c286fc81), [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b), [`2fb8fb3`](https://github.com/ydb-platform/ydb-js-sdk/commit/2fb8fb33b7c7ffdb7a35fd986e27453d762e97f3), [`6c5994d`](https://github.com/ydb-platform/ydb-js-sdk/commit/6c5994db17833904b30e556ddd5f44a9af0830e7), [`fad487e`](https://github.com/ydb-platform/ydb-js-sdk/commit/fad487ee4c059c95cc89bb54d01af9d37b400a24), [`de9a120`](https://github.com/ydb-platform/ydb-js-sdk/commit/de9a12066039fac5ac4e701c48014bd320eefa77), [`84798d1`](https://github.com/ydb-platform/ydb-js-sdk/commit/84798d1a4ef66a62b7da8d13f709c261d761ca85), [`294b07c`](https://github.com/ydb-platform/ydb-js-sdk/commit/294b07c4875e0752509ec8b4d5a0fc9a04f9be57), [`74d66f3`](https://github.com/ydb-platform/ydb-js-sdk/commit/74d66f3eda573229b652a03401cade4d21139427), [`f518b6a`](https://github.com/ydb-platform/ydb-js-sdk/commit/f518b6a70376a0f20c42d208d3e3ad4b9226b3ce), [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b), [`52e319f`](https://github.com/ydb-platform/ydb-js-sdk/commit/52e319f3f9fab7ca2d71dd732725a788310c5b8c), [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b), [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b)]:
  - @ydbjs/api@7.0.0
  - @ydbjs/core@7.0.0
  - @ydbjs/value@7.0.0
  - @ydbjs/query@7.0.0

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
