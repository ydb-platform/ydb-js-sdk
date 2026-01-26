# @ydbjs/topic

## 6.1.1

### Patch Changes

- [#554](https://github.com/ydb-platform/ydb-js-sdk/pull/554) [`85b2ea0`](https://github.com/ydb-platform/ydb-js-sdk/commit/85b2ea05092e96943ccc2ed2fe1164d67345a910) Thanks [@polRk](https://github.com/polRk)! - Fix commit hanging indefinitely when there's a gap between committedOffset and first available message offset (e.g., due to retention policy deleting old messages).

## 6.1.0

### Minor Changes

- [#545](https://github.com/ydb-platform/ydb-js-sdk/pull/545) [`4a8ebba`](https://github.com/ydb-platform/ydb-js-sdk/commit/4a8ebba603527b10a9ffa9f1f7be244a99c72451) Thanks [@polRk](https://github.com/polRk)! - Fix seqNo renumbering bug in both writer implementations and simplify TopicWriter API.

  **Bug fix:**
  - Fixed issue where messages written before session initialization were not renumbered after receiving `lastSeqNo` from server. Previously, auto-generated seqNo started from 0 and were not updated when server provided actual `lastSeqNo`, causing seqNo conflicts. Now messages are properly renumbered to continue from server's `lastSeqNo + 1`.
  - Fixed in both `writer` (legacy) and `writer2` implementations

  **API changes:**
  - `TopicWriter.write()` no longer returns sequence number (now returns `void`) to simplify API and prevent confusion about temporary vs final seqNo values

  **Migration guide:**
  - If you were storing seqNo from `write()` return value, use `flush()` instead to get final seqNo:

    ```typescript
    // Before
    let seqNo = writer.write(data)

    // After
    writer.write(data)
    let lastSeqNo = await writer.flush() // Get final seqNo
    ```

  - User-provided seqNo (via `extra.seqNo`) remain final and unchanged - no migration needed for this case.

### Patch Changes

- [#547](https://github.com/ydb-platform/ydb-js-sdk/pull/547) [`a0f39b6`](https://github.com/ydb-platform/ydb-js-sdk/commit/a0f39b6e3cf974feb1345c9f6eeca25d82ed1aeb) Thanks [@polRk](https://github.com/polRk)! - Fix memory leaks in topic reader implementation.
  - Fixed memory leaks in AsyncPriorityQueue by properly clearing items and resetting state
  - Improved abort signal handling to prevent memory accumulation from composite signals
  - Enhanced resource cleanup in TopicReader and TopicTxReader destroy methods
  - Added proper disposal of outgoing queue and message buffers
  - Added both sync and async disposal support with proper cleanup
  - Added memory leak test to prevent regressions

## 6.0.7

### Patch Changes

- Fix discovery client undefined check

- Updated dependencies []:
  - @ydbjs/core@6.0.7

## 6.0.6

### Patch Changes

- Fix memory leaks in Driver class

- Updated dependencies []:
  - @ydbjs/core@6.0.6

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/api@6.0.5
  - @ydbjs/core@6.0.5
  - @ydbjs/debug@6.0.5
  - @ydbjs/error@6.0.5
  - @ydbjs/retry@6.0.5
  - @ydbjs/value@6.0.5

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies
- Updated dependencies [cb0db2f]
  - @ydbjs/debug@6.0.4
  - @ydbjs/error@6.0.4
  - @ydbjs/retry@6.0.4
  - @ydbjs/value@6.0.4
  - @ydbjs/core@6.0.4
  - @ydbjs/api@6.0.4

## 6.0.3

### Patch Changes

- Fix access to tx in topic reader
  - @ydbjs/api@6.0.3
  - @ydbjs/core@6.0.3
  - @ydbjs/debug@6.0.3
  - @ydbjs/error@6.0.3
  - @ydbjs/retry@6.0.3
  - @ydbjs/value@6.0.3

## 6.0.2

### Patch Changes

- @ydbjs/api@6.0.2
- @ydbjs/core@6.0.2
- @ydbjs/debug@6.0.2
- @ydbjs/error@6.0.2
- @ydbjs/retry@6.0.2
- @ydbjs/value@6.0.2

## 6.0.1

### Patch Changes

- Update topic tx reader/client client constructor. Remove disposable features for tx clients.
  - @ydbjs/api@6.0.1
  - @ydbjs/core@6.0.1
  - @ydbjs/debug@6.0.1
  - @ydbjs/error@6.0.1
  - @ydbjs/retry@6.0.1
  - @ydbjs/value@6.0.1
