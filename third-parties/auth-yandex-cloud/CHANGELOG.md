# @ydbjs/auth-yandex-cloud

## 0.2.1

### Patch Changes

- [#675](https://github.com/ydb-platform/ydb-js-sdk/pull/675) [`7380673`](https://github.com/ydb-platform/ydb-js-sdk/commit/7380673c1f41fff1329521202dc8759419ee9b1f) Thanks [@polRk](https://github.com/polRk)! - Keep shared token refreshes independent of individual callers. Static, metadata, and Yandex Cloud providers own a five-second foreground request budget, including retries; static and Yandex Cloud background refreshes have a thirty-second budget. Cancelling a token request stops only that caller's wait. Cached reads and callers joining a refresh do not create provider timeouts.
- Updated dependencies [[`1cb8668`](https://github.com/ydb-platform/ydb-js-sdk/commit/1cb8668cb014cf7603114666eb0f21064792eaa6), [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096), [`7380673`](https://github.com/ydb-platform/ydb-js-sdk/commit/7380673c1f41fff1329521202dc8759419ee9b1f), [`9e16c2c`](https://github.com/ydb-platform/ydb-js-sdk/commit/9e16c2c2524658a1f56fdd465a317f4a2ae64846), [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28), [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1)]:
  - @ydbjs/abortable@6.2.0
  - @ydbjs/auth@7.0.0
  - @ydbjs/retry@7.0.0
  - @ydbjs/debug@6.0.6

## 0.2.0

### Minor Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`c388ccc`](https://github.com/ydb-platform/ydb-js-sdk/commit/c388cccef45a6f5c6ba325df7f80d9b8337b156b) Thanks [@polRk](https://github.com/polRk)! - Participate in the `node:diagnostics_channel` surface defined by `@ydbjs/auth`.

  `ServiceAccountCredentialsProvider` now publishes:
  - `tracing:ydb:auth.token.fetch` — span around `getToken()` with `provider: 'yc-service-account'`.
  - `ydb:auth.token.refreshed` — `{ provider, expiresAt }` after a successful IAM token exchange.
  - `ydb:auth.token.expired` — `{ provider, stalenessMs }`, once per incident.
  - `ydb:auth.provider.failed` — `{ provider, error }` when all retries are exhausted.

  Retry attempts inside the IAM exchange are visible on `tracing:ydb:retry.*` from `@ydbjs/retry`. See `@ydbjs/auth` README for the full channel contract and the warning about safe subscribers.

### Patch Changes

- Updated dependencies [[`c388ccc`](https://github.com/ydb-platform/ydb-js-sdk/commit/c388cccef45a6f5c6ba325df7f80d9b8337b156b), [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448), [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f), [`17d1020`](https://github.com/ydb-platform/ydb-js-sdk/commit/17d10200b0dbd1dd0d48041bf377f91dc1a15d75)]:
  - @ydbjs/auth@6.3.0
  - @ydbjs/retry@6.3.0

## 0.1.2

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/auth@6.0.5
  - @ydbjs/debug@6.0.5
  - @ydbjs/retry@6.0.5

## 0.1.1

### Patch Changes

- a48d01c: Fix Service Account provider: clean private key in constructor
  - Move private key cleaning from JWT creation to constructor for better performance
  - Remove unnecessary log about warning line detection
  - Add key ID to debug logs for better traceability
  - Directly modify key.private_key instead of creating new object

## 0.1.0

### Minor Changes

- 701816e: Add Yandex Cloud Service Account authentication provider
  - New package `@ydbjs/auth-yandex-cloud` for authenticating with Yandex Cloud Service Account authorized keys
  - Supports JWT creation with PS256 algorithm
  - Automatic IAM token management with caching and background refresh
  - Built-in retry logic with exponential backoff for IAM API calls
  - Multiple initialization methods: from file, environment variable, or JSON object
