# @ydbjs/query

## 7.0.0

### Major Changes

- [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096) Thanks [@polRk](https://github.com/polRk)! - Connect SDK services to `@ydbjs/grpc` and remove nice-grpc and grpc-js from the workspace. Service methods retain Promise results and AsyncIterable request/response streams, with AbortSignal cancellation and backpressure. Requires Node.js 22.15 or later supported by the SDK.

  Use `createServiceClient(service, transport)` for standalone calls. `Driver.createClient` retains discovery and node selection; `createPinnedClient` explicitly awaits endpoint pin acquisition. Configure TLS, message limits, and HTTP/2 windows through `transportOptions`. The transport does not replay RPCs or duplicate YDB balancing and retry policies.

  Call options accept plain metadata records, signals, absolute deadlines, and header/trailer/status observers. `RpcError` carries code, details, and trailing metadata; `MessageSizeError` identifies permanent local size-limit failures. Query metadata events expose the same record format. Register `addMetadataHook` before constructing Driver to add tracing headers. Credential providers supply `getToken`; Driver handles authentication and mandatory headers without middleware or interceptor adapters.

  High-level TopicWriter, TopicReader, query, and coordination operations retain their APIs. Generated API definitions remain independent of the transport at runtime. Request framing sends the header and serialized body separately, avoiding the payload copy used to prepend a gRPC frame header.

  Preserve explicit TLS server names when discovery provides no override, and avoid logging raw driver options.

  Preserve explicit gRPC endpoint ports when selecting TLS, including mixed-case URL schemes. Merge repeated case-insensitive call metadata values while keeping required driver headers authoritative over caller metadata and hooks.

### Minor Changes

- [#704](https://github.com/ydb-platform/ydb-js-sdk/pull/704) [`4f76c1e`](https://github.com/ydb-platform/ydb-js-sdk/commit/4f76c1e760106f5305f9eddd2db5322e172214b7) Thanks [@polRk](https://github.com/polRk)! - Add graceful `QueryClient.close()` and immediate `destroy()`. Async disposal drains accepted queries, transactions and session cleanup; synchronous disposal cancels owned work without closing the shared Driver. Release query resources after failed readiness and destruction, and prevent late cleanup RPCs or callbacks after shutdown.

  Keep actual query and transaction attempts owned until their cleanup completes, even when caller cancellation has already rejected the retry wrapper. Graceful close waits for rollback and close hooks; destroy still cancels them immediately.

### Patch Changes

- [#666](https://github.com/ydb-platform/ydb-js-sdk/pull/666) [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28) Thanks [@polRk](https://github.com/polRk)! - Upgrade protobuf to 2.16.0 to reduce temporary allocations during serialization and parsing.

- [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1) Thanks [@polRk](https://github.com/polRk)! - Refresh compatible dependency versions and remove unused runtime packages. Include the `ms` types required by the Topic reader's published declarations.
- Updated dependencies [[`1cb8668`](https://github.com/ydb-platform/ydb-js-sdk/commit/1cb8668cb014cf7603114666eb0f21064792eaa6), [`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`cdff086`](https://github.com/ydb-platform/ydb-js-sdk/commit/cdff0864d850ba1bd1c7cf7c7041dd9742f04ef6), [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a), [`64df3b5`](https://github.com/ydb-platform/ydb-js-sdk/commit/64df3b50005490e7c5a1628a6a9f31cb19e07d3d), [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338), [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8), [`e6960f6`](https://github.com/ydb-platform/ydb-js-sdk/commit/e6960f6b4170c7d399739b364c45ed5ca8374eb4), [`549da21`](https://github.com/ydb-platform/ydb-js-sdk/commit/549da21a2f16312e5c774cb34ab4de87f40f3005), [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a), [`031e586`](https://github.com/ydb-platform/ydb-js-sdk/commit/031e586337262eca797d5bbd013dc9c0fedc9f1b), [`dc41967`](https://github.com/ydb-platform/ydb-js-sdk/commit/dc419672abd79679b8f5d819067c374d9ff59208), [`986e841`](https://github.com/ydb-platform/ydb-js-sdk/commit/986e841781aebe4adb7d05a3deeeb105536fac93), [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096), [`b9342a1`](https://github.com/ydb-platform/ydb-js-sdk/commit/b9342a1648be7805047af2c15c43306998ee1726), [`9e16c2c`](https://github.com/ydb-platform/ydb-js-sdk/commit/9e16c2c2524658a1f56fdd465a317f4a2ae64846), [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28), [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1), [`6ad8ff0`](https://github.com/ydb-platform/ydb-js-sdk/commit/6ad8ff016a40d9036add4d7db8dc5d0e6b8365de)]:
  - @ydbjs/abortable@6.2.0
  - @ydbjs/api@7.0.0
  - @ydbjs/core@7.0.0
  - @ydbjs/grpc@0.2.0
  - @ydbjs/retry@7.0.0
  - @ydbjs/error@6.1.0
  - @ydbjs/value@6.0.9
  - @ydbjs/debug@6.0.6

## 6.3.0

### Minor Changes

- [#622](https://github.com/ydb-platform/ydb-js-sdk/pull/622) [`692a8ee`](https://github.com/ydb-platform/ydb-js-sdk/commit/692a8ee44b0ccfc3f283f1e1b93e47449938efe3) Thanks [@polRk](https://github.com/polRk)! - Add composable query fragments: `fragment` (and `sql.fragment`) builds a non-executable piece of YQL with its own bound parameters, and `join` (and `sql.join`) combines fragments with a separator. Fragments nest into other `sql`/`fragment` templates, with parameters renumbered automatically — enabling dynamic `WHERE`/`IN`/KNN clauses without hand-building parameter names.

### Patch Changes

- [#623](https://github.com/ydb-platform/ydb-js-sdk/pull/623) [`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63) Thanks [@polRk](https://github.com/polRk)! - Bump `@bufbuild/protobuf` from `2.10.1` to `2.12.0`.

- Updated dependencies [[`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63)]:
  - @ydbjs/api@6.0.7
  - @ydbjs/core@6.3.1
  - @ydbjs/error@6.0.6
  - @ydbjs/value@6.0.8

## 6.2.0

### Minor Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448) Thanks [@polRk](https://github.com/polRk)! - Follow-ups to the `node:diagnostics_channel` instrumentation:

  `@ydbjs/query` — new tracing channels around transaction control RPCs:
  - `tracing:ydb:query.begin` — `BeginTransaction`. Context: `{ sessionId, nodeId, isolation }`.
  - `tracing:ydb:query.commit` — `CommitTransaction`. Context: `{ sessionId, nodeId, txId }`.
  - `tracing:ydb:query.rollback` — `RollbackTransaction`. Context: `{ sessionId, nodeId, txId }`. Fire-and-forget — `start` always fires, `asyncEnd` may land after the surrounding `query.transaction.error`.

  `tracing:ydb:query.execute` is reserved for `ExecuteQuery` RPCs only; subscribers building per-statement metrics should not expect `query.execute` events for begin/commit/rollback.

  Bug fixes:
  - `@ydbjs/query` — releasing a checked-out session after `pool.close()` no longer publishes `ydb:session.closed` twice. The eviction listener is detached before `session.close()` fires its abort.
  - `@ydbjs/core` — `Driver.close()` now cancels in-flight discovery and rejects pending `ready()` waiters. `ydb:driver.ready` / `ydb:driver.failed` no longer fire after `ydb:driver.closed`.
  - `@ydbjs/core` — `pool.pessimize()` only publishes `ydb:pool.connection.pessimized` (and calls the `onPessimize` hook) on the active→pessimized transition. Repeated pessimize calls that just refresh the timeout are now silent, so subscribers reconstructing pool state from delta events don't see phantom transitions.

  Documentation contract clarifications (no behavior change, but subscribers built from the previous wording were wrong):
  - `@ydbjs/retry` — `tracing:ydb:retry.attempt.error` fires for **every** failed attempt, including the final non-retried one. The README previously implied it fires only for attempts that will be retried.
  - `@ydbjs/auth` — the `provider` field is an open string set (custom `CredentialsProvider` implementations may contribute new values), not an enum. Subscribers should treat it as a label rather than write exhaustive switches.

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`be55d0c`](https://github.com/ydb-platform/ydb-js-sdk/commit/be55d0cfe8cd182ed1c0aa58be53687f4587d92d) Thanks [@polRk](https://github.com/polRk)! - Publish query, transaction, and session-pool events on `node:diagnostics_channel`.

  New channels:
  - `tracing:ydb:query.execute` — span around a single `ExecuteQuery` RPC. Context: `{ text, sessionId, nodeId, idempotent, isolation, stage }`. `stage` is `'standalone' | 'tx' | 'do'`.
  - `tracing:ydb:query.transaction` — span around `tx.begin` → `commit`/`rollback` including retries. Context: `{ isolation, idempotent }`.
  - `tracing:ydb:session.acquire` — span around `pool.acquire()`. Context: `{ kind: 'query' | 'transaction' }`.
  - `tracing:ydb:session.create` — span around `Session.open()` when the pool grows. Context: `{ liveSessions, maxSize, creating }`.
  - `ydb:session.created` — `{ sessionId, nodeId }`.
  - `ydb:session.closed` — `{ sessionId, nodeId, reason, uptime }` with `reason: 'evicted' | 'pool_close'`. Fires exactly once per session, replacing the previous pair of `evicted` + `destroyed` events (which could double-fire on `pool.close()`).

  Retry-loop spans (`tracing:ydb:retry.*`) come from `@ydbjs/retry` and nest under `query.transaction` / `query.execute` via `AsyncLocalStorage` propagation — no per-callsite retry channel imports needed.

  Channel names, payload fields, and the `stage` / `reason` / `kind` enums are part of the public API. See `packages/query/README.md` for the full contract and a warning about safe subscribers.

- [#609](https://github.com/ydb-platform/ydb-js-sdk/pull/609) [`17d1020`](https://github.com/ydb-platform/ydb-js-sdk/commit/17d10200b0dbd1dd0d48041bf377f91dc1a15d75) Thanks [@polRk](https://github.com/polRk)! - OpenTelemetry metrics pipeline, semantic-convention cleanup, a `DeleteSession` span, and W3C trace context propagation in `@ydbjs/core`.

  `@ydbjs/telemetry`:
  - Attribute / event / metric constants are split across `src/semconv/{common,spans,events,metrics}.ts`. The old `src/attributes.ts` is gone; unused `ATTR_YDB_POOL_*` keys (`max_size`, `creating`, `live_sessions`) were dead and have been removed.
  - Connection-pool event names are now component-scoped: `ydb.pool.connection.*` → `ydb.driver.connection.*`. Same for `ATTR_YDB_POOL_*` → `ATTR_YDB_DRIVER_CONNECTION_*` (used as `addEvent` attributes).
  - `db.operation.name` carries a service prefix (`Query.ExecuteQuery`, `Query.BeginTransaction`, `Discovery.ListEndpoints`, ...) so traces stay unambiguous if the Table service is instrumented alongside Query later.
  - Time values: `node:diagnostics_channel` payloads stay in milliseconds (Node convention — `performance.now()` and `Date.now()` units). The OTel mapping divides by 1000 when assigning to attributes / metric data points, whose semantic unit is seconds. Attribute keys no longer carry the `_ms` suffix (e.g. `ydb.retry.backoff`, `ydb.discovery.duration`).
  - A new `ydb.DeleteSession` span (channel `tracing:ydb:query.session.delete`) wraps the per-session `DeleteSession` RPC, with `db.operation.name="Query.DeleteSession"`, `ydb.session.id`, `ydb.node.id`, `ydb.session.close.reason`, `ydb.session.uptime`.
  - Metrics pipeline (first cut) registers the following synchronous instruments via the package's OTel `Meter`:
    - `db.client.operation.duration` (Histogram, `s`) — emitted on every leaf CLIENT tracing channel, tagged with `db.operation.name`. Standard OTel database metric so off-the-shelf dashboards work out of the box.
    - `ydb.driver.connection.pessimizations` (Counter)
    - `ydb.query.session.create.duration` / `ydb.query.session.acquire.duration` (Histogram)
    - `ydb.query.session.closed` (Counter, tagged with `ydb.session.close.reason`)
    - `ydb.auth.token.fetch.duration` (Histogram), `ydb.auth.token.fetch.failures` (Counter), `ydb.auth.token.expirations` (Counter)
    - `ydb.retry.attempts` (Counter, tagged with `ydb.retry.outcome`), `ydb.retry.duration` (Histogram, end-to-end including backoffs)
  - Two observable instruments are also emitted, fed by an internal per-`DriverIdentity` state registry that subscribes to existing lifecycle events:
    - `ydb.driver.connection.count` (`ObservableUpDownCounter`, tagged with `ydb.connection.state` ∈ `{live, pessimized}`)
    - `ydb.query.session.count` (`ObservableUpDownCounter`, total only — state breakdown is a follow-up that needs `session.acquired/released` events from `@ydbjs/query`)
  - W3C trace context propagation: `register()` installs a gRPC client middleware (via `@ydbjs/core`'s new `addClientMiddleware`) that calls `propagation.inject(context.active(), metadata, …)` on every outgoing YDB RPC. Always on while the instrumentation is enabled — without an OTel SDK the global propagator is a no-op. Must be called before `new Driver(...)` for the middleware to apply.

  `@ydbjs/query`:
  - `SessionPool` accepts a new `minSize?: number` option (default `0`) — reported as `ydb.query.session.min` once that observable is wired up. No eager session pre-warm is performed today; the option exists for parity with other YDB SDKs and for future warm-up logic.
  - `ydb:query.session.pool.opened` payload now includes `minSize`.
  - `Session.close()` accepts a `SessionCloseReason` (`pool_close` | `attach_failed` | `stream_closed` | `stream_error`). The `DeleteSession` RPC is now published via `tracingChannel('tracing:ydb:query.session.delete')` so subscribers see a span around each background delete, with the reason on the context.
  - Session uptime is tracked on the `Session` itself (`readonly createdAt`) instead of in a parallel `WeakMap` inside the pool.

  `@ydbjs/retry`:
  - New `ydb:retry.attempt.completed` event published after every attempt, with `{ attempt, idempotent, outcome }` where `outcome` is `'success' | 'retried' | 'non_retryable' | 'exhausted'`. Feeds the `ydb.retry.attempts` counter.
  - `tracing:ydb:retry.run` context now carries an `outcome` field (set by the runner before resolve / throw) so subscribers can tag end-to-end retry duration histograms by outcome.

  `@ydbjs/core`:
  - `ydb:driver.connection.unpessimized` payload field is `duration` (ms).
  - New `addClientMiddleware(mw)` API — appends a `ClientMiddleware` to a
    process-global registry that `Driver` composes into its gRPC client chain
    at construction time. Returns a `Disposable` for cleanup. Used by
    `@ydbjs/telemetry` to install W3C trace context propagation without
    pulling OTel packages into `@ydbjs/core`. Drivers constructed before the
    registration do not pick up the new middleware — call before
    `new Driver(...)`.

### Patch Changes

- Updated dependencies [[`efa7adf`](https://github.com/ydb-platform/ydb-js-sdk/commit/efa7adf9e1346388a4358f3e1bf8a8ac5c85419b), [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448), [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f), [`17d1020`](https://github.com/ydb-platform/ydb-js-sdk/commit/17d10200b0dbd1dd0d48041bf377f91dc1a15d75)]:
  - @ydbjs/core@6.2.0
  - @ydbjs/retry@6.3.0

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
