# @ydbjs/value

## 7.0.0

### Major Changes

- [#715](https://github.com/ydb-platform/ydb-js-sdk/pull/715) [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b) Thanks [@polRk](https://github.com/polRk)! - Preserve extended temporal values and supported timezone values as SDK Values in default JavaScript results. Keep Date, Datetime and Timestamp results as JavaScript Date and Interval as a number; preserve Drizzle's declared Date and numeric column types.

  Replace date-fns/TZDate with exact Temporal inputs and timezone text. The application supplies globalThis.Temporal; the SDK does not install or register a polyfill. Timezone constructors require Temporal for validation, including string inputs. Reject excess precision, non-ISO calendars, calendar durations and ambiguous local times.

  Require TypeScript 7 or later for the standard Temporal declarations included by the published types.

- [#725](https://github.com/ydb-platform/ydb-js-sdk/pull/725) [`de9a120`](https://github.com/ydb-platform/ydb-js-sdk/commit/de9a12066039fac5ac4e701c48014bd320eefa77) Thanks [@polRk](https://github.com/polRk)! - Remove PostgreSQL Value types and the `@ydbjs/value/pg` entry point. Decoding a PostgreSQL schema now fails explicitly, including inside empty containers and absent Optionals. Query parameters reject PostgreSQL schemas, including custom Values. Query raw mode continues to return the wire values and type descriptors.

- [#715](https://github.com/ydb-platform/ydb-js-sdk/pull/715) [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b) Thanks [@polRk](https://github.com/polRk)! - Return null-prototype records from toJs(Struct), including nested Structs and Structs inside containers. Field names are ordinary own properties; use Object.hasOwn instead of inherited object methods.

- [#749](https://github.com/ydb-platform/ydb-js-sdk/pull/749) [`38b0c91`](https://github.com/ydb-platform/ydb-js-sdk/commit/38b0c91d1781bdd27f041b97e1a100ef70e9d3bd) Thanks [@polRk](https://github.com/polRk)! - Add Float32Vector, Int8Vector, Uint8Vector, and BitVector values for YDB vector search. Encode numeric arrays directly into compact YDB String parameters, validate packed input, and expose owned typed-array projections. Decode known tagged vector results without constructing per-coordinate Values while preserving ordinary binary String results.

  Infer native Int8Array parameters as List<Int8>; use Int8Vector explicitly for compact binary storage.

### Minor Changes

- [#726](https://github.com/ydb-platform/ydb-js-sdk/pull/726) [`4b3db40`](https://github.com/ydb-platform/ydb-js-sdk/commit/4b3db408e6875661588f6428ff28f20081c90c34) Thanks [@polRk](https://github.com/polRk)! - Add opt-in Temporal result conversion with toJs(value, { temporal: true }), new QueryClient(driver, { temporal: true }) and query(driver, { temporal: true }). Preserve the default Value/Date representations when the option is disabled.

  Use the application-provided global Temporal implementation. TzDate and TzDate32 remain SDK Values because Temporal has no zoned date-only type. Preserve Drizzle's Date and numeric column representations with Temporal-enabled clients.

- [#731](https://github.com/ydb-platform/ydb-js-sdk/pull/731) [`2fb8fb3`](https://github.com/ydb-platform/ydb-js-sdk/commit/2fb8fb33b7c7ffdb7a35fd986e27453d762e97f3) Thanks [@polRk](https://github.com/polRk)! - Add Decimal and DecimalType with exact string and scaled-bigint construction, binary decoding, native string projection and precision/scale validation.

  Reject invalid unsigned wire words before composing the signed coefficient, so malformed values cannot be truncated into valid decimals.

- [#733](https://github.com/ydb-platform/ydb-js-sdk/pull/733) [`6c5994d`](https://github.com/ydb-platform/ydb-js-sdk/commit/6c5994db17833904b30e556ddd5f44a9af0830e7) Thanks [@polRk](https://github.com/polRk)! - Add DyNumber and DyNumberType constructors and preserve exact decimal text in query parameters and native string results.

- [#732](https://github.com/ydb-platform/ydb-js-sdk/pull/732) [`fad487e`](https://github.com/ydb-platform/ydb-js-sdk/commit/fad487ee4c059c95cc89bb54d01af9d37b400a24) Thanks [@polRk](https://github.com/polRk)! - Add EmptyList and EmptyDict constructors. Preserve their distinct wire schemas during decoding and project them to native arrays and Maps.

- [#735](https://github.com/ydb-platform/ydb-js-sdk/pull/735) [`84798d1`](https://github.com/ydb-platform/ydb-js-sdk/commit/84798d1a4ef66a62b7da8d13f709c261d761ca85) Thanks [@polRk](https://github.com/polRk)! - Add Tagged and TaggedType to preserve result tags and typed payloads. Reject Tagged parameter schemas before ExecuteQuery; apply AsTagged in YQL instead.

- [#736](https://github.com/ydb-platform/ydb-js-sdk/pull/736) [`294b07c`](https://github.com/ydb-platform/ydb-js-sdk/commit/294b07c4875e0752509ec8b4d5a0fc9a04f9be57) Thanks [@polRk](https://github.com/polRk)! - Add Void and VoidType with explicit typed results and query parameter support.

- [#734](https://github.com/ydb-platform/ydb-js-sdk/pull/734) [`74d66f3`](https://github.com/ydb-platform/ydb-js-sdk/commit/74d66f3eda573229b652a03401cade4d21139427) Thanks [@polRk](https://github.com/polRk)! - Add TzDate32, TzDatetime64 and TzTimestamp64 with exact timezone text, Temporal inputs and validation across extended YDB ranges. Keep results as typed Values by default.

- [#724](https://github.com/ydb-platform/ydb-js-sdk/pull/724) [`f518b6a`](https://github.com/ydb-platform/ydb-js-sdk/commit/f518b6a70376a0f20c42d208d3e3ad4b9226b3ce) Thanks [@polRk](https://github.com/polRk)! - Add Date32, Datetime64, Timestamp64 and Interval64 constructors with exact units and Temporal inputs. Preserve their default typed Value representation and validate server ranges.

### Patch Changes

- [#715](https://github.com/ydb-platform/ydb-js-sdk/pull/715) [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b) Thanks [@polRk](https://github.com/polRk)! - Preserve the presence of outer Optional values when an inner Optional is null. Encode the required nested_value wrapper and unwrap the corresponding level when decoding query results, instead of returning a protobuf object as a native scalar.

  Preserve struct members such as `__proto__` as own data properties, and apply the same own-field rule to single objects and lists of objects.

- [#742](https://github.com/ydb-platform/ydb-js-sdk/pull/742) [`c04cd9d`](https://github.com/ydb-platform/ydb-js-sdk/commit/c04cd9df0dc77f7d4115b096742c0754e68b4b26) Thanks [@polRk](https://github.com/polRk)! - Stop generating `DECLARE` statements for tagged SQL. Write explicit declarations for servers or parameter types that require them. Named bindings with `.parameter()` and `.param()` now infer YDB types from native JavaScript values. Pass an SDK Value to select an exact type, or `undefined` to clear a binding. Malformed explicit Values throw when bound. QueryClient.driver exposes its underlying Driver for adapters sharing the client.

- [#666](https://github.com/ydb-platform/ydb-js-sdk/pull/666) [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28) Thanks [@polRk](https://github.com/polRk)! - Upgrade protobuf to 2.16.0 to reduce temporary allocations during serialization and parsing.

- [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1) Thanks [@polRk](https://github.com/polRk)! - Refresh compatible dependency versions and remove unused runtime packages. Include the `ms` types required by the Topic reader's published declarations.

- [#721](https://github.com/ydb-platform/ydb-js-sdk/pull/721) [`52e319f`](https://github.com/ydb-platform/ydb-js-sdk/commit/52e319f3f9fab7ca2d71dd732725a788310c5b8c) Thanks [@polRk](https://github.com/polRk)! - Encode Interval parameters using the signed 64-bit microsecond field and reject inputs that cannot represent exact integer microseconds. Keep leading zeros in TzTimestamp fractional seconds and encode Float64Array parameters as Double values.

- [#715](https://github.com/ydb-platform/ydb-js-sdk/pull/715) [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b) Thanks [@polRk](https://github.com/polRk)! - Preserve declared schemas when decoding supported values, including nested Optional presence, typed empty and nullable containers, Struct member order and UUID bits. Reject incompatible schemas and malformed wire values before silently losing data. Apply the same value classification inside arrays as for standalone values.

  Preserve scalar values without an unambiguous native representation as typed SDK Values. Variant results require raw mode.

- [#715](https://github.com/ydb-platform/ydb-js-sdk/pull/715) [`6702070`](https://github.com/ydb-platform/ydb-js-sdk/commit/67020705c757ba4b0e5680b00e3107351bd9843b) Thanks [@polRk](https://github.com/polRk)! - Validate primitive JavaScript payload types and scalar ranges in Value construction, including values decoded from protobuf. Reject implicit boolean, numeric, string and byte-array coercions before encoding; preserve valid floating-point special values and UUID words.

  Remove repeated checks from numeric wrappers and native result projection. Keep precision checks before conversions that could lose information.

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096), [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28)]:
  - @ydbjs/api@7.0.0

## 6.0.8

### Patch Changes

- [#623](https://github.com/ydb-platform/ydb-js-sdk/pull/623) [`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63) Thanks [@polRk](https://github.com/polRk)! - Bump `@bufbuild/protobuf` from `2.10.1` to `2.12.0`.

- Updated dependencies [[`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63)]:
  - @ydbjs/api@6.0.7

## 6.0.7

### Patch Changes

- [#594](https://github.com/ydb-platform/ydb-js-sdk/pull/594) [`5f535cf`](https://github.com/ydb-platform/ydb-js-sdk/commit/5f535cf46d1f1350f16076d47b085f10952def0d) Thanks [@polRk](https://github.com/polRk)! - Fix Struct constructor double-wrapping fields declared as Optional

  When a type definition was provided, the constructor wrapped every field in `Optional` regardless of the value's actual type. For fields declared `Optional<T>` with a concrete value already of type `T`, this produced `Optional<Optional<T>>` and caused encoding mismatches against the declared struct type.

  The constructor now only wraps `null` in `Optional` (using the declared item type); values are passed through unchanged. Missing values for non-`Optional` fields now throw instead of silently becoming `Optional(null)`.

## 6.0.6

### Patch Changes

- [`b2bf87d`](https://github.com/ydb-platform/ydb-js-sdk/commit/b2bf87d72ebbd8b7028e2c831f354f2a40f99fa9) Thanks [@polRk](https://github.com/polRk)! - Add extra js native values to parse
  - Float32Array
  - Float64Array
  - BigInt64Array
  - BigUint64Array

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/api@6.0.5

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies
- Updated dependencies [cb0db2f]
  - @ydbjs/api@6.0.4

## 6.0.3

### Patch Changes

- @ydbjs/api@6.0.3

## 6.0.2

### Patch Changes

- @ydbjs/api@6.0.2

## 6.0.1

### Patch Changes

- @ydbjs/api@6.0.1
