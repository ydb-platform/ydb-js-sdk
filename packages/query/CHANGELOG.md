# @ydbjs/query

## 6.1.0

### Minor Changes

- [#589](https://github.com/ydb-platform/ydb-js-sdk/pull/589) [`9e79fca`](https://github.com/ydb-platform/ydb-js-sdk/commit/9e79fca524cd3912a8a5611ad2f2e1c430e0dddf) Thanks [@polRk](https://github.com/polRk)! - Add session pool for query service

  Sessions are now pooled and reused across queries and transactions instead of being created per-operation. Acquired sessions are handed out as disposable leases (`using`), so they return to the pool automatically at the end of the scope — including on thrown errors and mid-retry aborts.

  Pool behavior:
  - Bounded size (default `maxSize: 50`) with a FIFO waiter queue capped at `maxSize * waitQueueFactor` (default 8); over-cap callers get `SessionPoolFullError` instead of queueing unbounded.
  - LIFO reuse of idle sessions to keep the hot set warm and let cold sessions age out.
  - Server-side eviction frees the slot for the oldest waiter rather than rejecting the whole wait queue.
  - `close()` waits for in-flight session creation to finish, so late-completing creates don't land in a closed pool.

  Session lifecycle:
  - `Session.open` creates the server-side session and binds the `attachSession` keepalive atomically; on attach failure the server-side session is deleted before the error surfaces, so no sessions leak on the error path.
  - A single `AbortSignal` on the session (and mirrored per-lease) drives cancellation — in-flight operations abort automatically when the session dies.
  - Retries acquire a fresh lease per attempt and the transaction context is attempt-scoped, so a dead session no longer poisons subsequent retry attempts. The caller's `idempotent` flag is honored end-to-end.

  Configure via `query(driver, { poolOptions: { maxSize: 100, waitQueueFactor: 8 } })`.

### Patch Changes

- Updated dependencies [[`b2bf87d`](https://github.com/ydb-platform/ydb-js-sdk/commit/b2bf87d72ebbd8b7028e2c831f354f2a40f99fa9), [`5c54025`](https://github.com/ydb-platform/ydb-js-sdk/commit/5c54025de89a475f6cdbb81308c9dd106224e33a)]:
  - @ydbjs/value@6.0.6
  - @ydbjs/core@6.1.1

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

- @ydbjs/api@6.0.3
- @ydbjs/core@6.0.3
- @ydbjs/debug@6.0.3
- @ydbjs/error@6.0.3
- @ydbjs/retry@6.0.3
- @ydbjs/value@6.0.3

## 6.0.2

### Patch Changes

- Export type Query from query client
  - @ydbjs/api@6.0.2
  - @ydbjs/core@6.0.2
  - @ydbjs/debug@6.0.2
  - @ydbjs/error@6.0.2
  - @ydbjs/retry@6.0.2
  - @ydbjs/value@6.0.2

## 6.0.1

### Patch Changes

- @ydbjs/api@6.0.1
- @ydbjs/core@6.0.1
- @ydbjs/debug@6.0.1
- @ydbjs/error@6.0.1
- @ydbjs/retry@6.0.1
- @ydbjs/value@6.0.1
