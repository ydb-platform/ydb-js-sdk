# @ydbjs/value

## 6.0.9

### Patch Changes

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be)]:
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
