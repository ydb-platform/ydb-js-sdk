# @ydbjs/fsm

## 7.0.0

### Major Changes

- [#637](https://github.com/ydb-platform/ydb-js-sdk/pull/637) [`6c3dee3`](https://github.com/ydb-platform/ydb-js-sdk/commit/6c3dee3e5a84c666c3425cac779e18adc53be2b1) Thanks [@YandalfRed](https://github.com/YandalfRed)! - Rework the runtime around a declarative lifecycle and surface faults to consumers.

  Breaking changes:

  - `EffectRuntime` no longer exposes `close()`, `destroy()`, or `ingest()` — it is now identical to `TransitionRuntime` (state, signal, emit, dispatch). Transitions and effect handlers run inside the event-drain loop, so awaiting the machine's own closure from there was a structural promise-cycle deadlock, and closing it mid-drain silently dropped queued outputs.
  - A transition declares termination by returning `final: { reason }` in its `TransitionResult`: the machine stops accepting new events immediately, runs that transition's effects (cleanup), drains events already queued, then seals the output stream; `reason` lands on `signal.reason`. An effect that hits an unrecoverable error `throw`s — the machine is destroyed and the output iterator rethrows the error.
  - `AbstractAsyncQueue.dispose()` (from `@ydbjs/fsm/queue`) is removed — it was a pure alias of `destroy()`; call `destroy()` or rely on `using` (`[Symbol.dispose]` now calls `destroy()` directly).

  Fixes and additions:

  - Internal machine faults now reach output consumers. When a transition, effect, or ingest source throws, the runtime still tears the machine down, but its output async-iterator rethrows the stop reason after draining instead of ending silently — so a consumer iterating the machine observes the failure and runs its terminal handling rather than mistaking a fault for a graceful close. The fault is delivered through the output queue via a new `AsyncQueue.fail(error)` primitive (seals the queue like `close()`, but the iterator throws `error` once the buffer drains). The iterator stays a direct queue passthrough — wrapping it in an async generator would add a per-item microtask that reorders delivery for latency-sensitive consumers.
  - New `AsyncQueue.take(signal?)`: a cancellable single-step dequeue with the iterator's exact contract (pause, drain-then-throw after `fail()`). Aborting removes the parked waiter atomically inside the queue, so a cancelled `take()` can never swallow an item — unlike racing `iterator.next()` with a promise combinator, which leaves the underlying `next()` pending. Compose a bounded wait at the call site with `linkSignals(signal, AbortSignal.timeout(ms))`.
  - An event dispatched synchronously from within a transition is now processed after the current transition's state change is applied, instead of being run re-entrantly against the stale (pre-transition) state.
  - `close()` now waits for an in-flight drain to finish and drains any tail before sealing the output stream, so outputs from events queued during that drain are not dropped.

### Patch Changes

- [#682](https://github.com/ydb-platform/ydb-js-sdk/pull/682) [`af97a85`](https://github.com/ydb-platform/ydb-js-sdk/commit/af97a858daea4a5a0a0df647abe19cf0f1e6bdb7) Thanks [@polRk](https://github.com/polRk)! - Preserve queued items when a paused consumer is cancelled immediately after the queue resumes. Release the previous yielded payload while an iterator waits for its next item.

- [#671](https://github.com/ydb-platform/ydb-js-sdk/pull/671) [`27bdd45`](https://github.com/ydb-platform/ydb-js-sdk/commit/27bdd45166b1e6b12bd7f83a559128cbb0f43ec1) Thanks [@polRk](https://github.com/polRk)! - Drain queued events with an indexed FIFO and release consumed references without repeatedly shifting the backlog. Avoid redundant drain waiters and Promise work for effect-free dispatch, and reuse the fulfilled Promise within each drain of synchronous effects. Preserve event order, microtask boundaries, shutdown behavior, and asynchronous context lifetime. Do not open an ingest source when its signal is already aborted.

- [#670](https://github.com/ydb-platform/ydb-js-sdk/pull/670) [`0ca6e3a`](https://github.com/ydb-platform/ydb-js-sdk/commit/0ca6e3a44991d9aceedca3d777d86d1c8c3f9aae) Thanks [@polRk](https://github.com/polRk)! - Keep queue readers isolated across reset, honor repeated pauses, and preserve already assigned values and terminal results during cancellation.
- Updated dependencies [[`1cb8668`](https://github.com/ydb-platform/ydb-js-sdk/commit/1cb8668cb014cf7603114666eb0f21064792eaa6)]:
  - @ydbjs/abortable@6.2.0

## 6.1.1

### Patch Changes

- [`85df091`](https://github.com/ydb-platform/ydb-js-sdk/commit/85df0919b73532791c479fa8c2b397bfc8b8bab8) Thanks [@polRk](https://github.com/polRk)! - Fix memory leak in event ingestion caused by `AbortSignal.any()`

  `AbortSignal.any()` registers event listeners on all source signals but never removes them, leading to a listener leak every time an event source is ingested. Replace it with `linkSignals` from `@ydbjs/abortable@^6.1.0`, which uses `Symbol.dispose` to clean up listeners when the ingestion task completes.

  Additional improvements:
  - Use `combined.signal` instead of `combined` directly for abort checks (correct API usage)
  - Separate abort signal checks from internal state checks for better readability and clearer control flow

## 6.1.0

### Minor Changes

- [#566](https://github.com/ydb-platform/ydb-js-sdk/pull/566) [`9f0f297`](https://github.com/ydb-platform/ydb-js-sdk/commit/9f0f29766a83626f649580611cc676dea9f89d38) Thanks [@polRk](https://github.com/polRk)! - Add new `@ydbjs/fsm` runtime package for async-first finite state machines in YDB JS SDK.
  - Introduce reusable runtime with single-writer event processing
  - Support typed transitions and effect handler maps
  - Add async source ingestion and runtime output as `AsyncIterable`
  - Add lifecycle controls: `close` (graceful) and `destroy` (hard shutdown)
  - Add package tests, design document, and runnable example in `examples/fsm`
