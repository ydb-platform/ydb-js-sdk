# @ydbjs/api

## 7.0.0

### Major Changes

- [#638](https://github.com/ydb-platform/ydb-js-sdk/pull/638) [`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be) Thanks [@polRk](https://github.com/polRk)! - Regenerate the protobuf types with the bridge / multi-pile (2-DC) API: `EndpointInfo.bridge_pile_name`, `ListEndpointsResult.pile_states`, `NodeLocation.bridge_pile_name`, and a new `@ydbjs/api/bridge` export exposing `PileState` / `PileState_State`. Also pick up newer upstream fields in discovery / query / topic / monitoring.

  **Breaking:** codegen moves to `protoc-gen-es` 2.12.x (aligned with the `@bufbuild/protobuf` 2.12 runtime), which honours `exactOptionalPropertyTypes`: optional message fields are now typed `T | undefined` instead of `T`. Consumers compiled with `exactOptionalPropertyTypes` that mirror generated optional fields into their own optional-typed fields must accept `undefined` (a type-level break, no behavioural change).

## 6.0.7

### Patch Changes

- [#623](https://github.com/ydb-platform/ydb-js-sdk/pull/623) [`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63) Thanks [@polRk](https://github.com/polRk)! - Bump `@bufbuild/protobuf` from `2.10.1` to `2.12.0`.

## 6.0.6

### Patch Changes

- [#559](https://github.com/ydb-platform/ydb-js-sdk/pull/559) [`ff96fe6`](https://github.com/ydb-platform/ydb-js-sdk/commit/ff96fe6a731269be1d093f60970a0b926c103076) Thanks [@vgvoleg](https://github.com/vgvoleg)! - Sync latest protospecs

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies

## 6.0.3

## 6.0.2

## 6.0.1
