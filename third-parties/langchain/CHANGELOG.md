# @ydbjs/langchain

## 0.1.0

### Minor Changes

- [#620](https://github.com/ydb-platform/ydb-js-sdk/pull/620) [`a7ba155`](https://github.com/ydb-platform/ydb-js-sdk/commit/a7ba155d94f3a3c92713c9af3a79657e0c7f0201) Thanks [@vgvoleg](https://github.com/vgvoleg)! - Initial release: `YDBVectorStore` — a LangChain.js VectorStore backed by YDB with KNN search, metadata filtering, and approximate nearest-neighbour index support.

  Registers `@ydbjs/langchain` and its version in the `x-ydb-sdk-build-info` gRPC header via `kRegisterLibrary`.

### Patch Changes

- Updated dependencies [[`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63), [`692a8ee`](https://github.com/ydb-platform/ydb-js-sdk/commit/692a8ee44b0ccfc3f283f1e1b93e47449938efe3)]:
  - @ydbjs/core@6.3.1
  - @ydbjs/query@6.3.0
  - @ydbjs/value@6.0.8

## 0.1.0

### Minor Changes

- Initial release: `YDBVectorStore` — a LangChain.js VectorStore backed by YDB with KNN search support.
