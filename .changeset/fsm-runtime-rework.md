---
'@ydbjs/fsm': major
---

Rework the runtime around a declarative lifecycle and surface faults to consumers.

Breaking changes:

- `EffectRuntime` no longer exposes `close()`, `destroy()`, or `ingest()` — it is now identical to `TransitionRuntime` (state, signal, emit, dispatch). Transitions and effect handlers run inside the event-drain loop, so awaiting the machine's own closure from there was a structural promise-cycle deadlock, and closing it mid-drain silently dropped queued outputs.
- A transition declares termination by returning `final: { reason }` in its `TransitionResult`: the machine stops accepting new events immediately, runs that transition's effects (cleanup), drains events already queued, then seals the output stream; `reason` lands on `signal.reason`. An effect that hits an unrecoverable error `throw`s — the machine is destroyed and the output iterator rethrows the error.
- `AbstractAsyncQueue.dispose()` (from `@ydbjs/fsm/queue`) is removed — it was a pure alias of `destroy()`; call `destroy()` or rely on `using` (`[Symbol.dispose]` now calls `destroy()` directly).

Fixes and additions:

- Internal machine faults now reach output consumers. When a transition, effect, or ingest source throws, the runtime still tears the machine down, but its output async-iterator rethrows the stop reason after draining instead of ending silently — so a consumer iterating the machine observes the failure and runs its terminal handling rather than mistaking a fault for a graceful close. The fault is delivered through the output queue via a new `AsyncQueue.fail(error)` primitive (seals the queue like `close()`, but the iterator throws `error` once the buffer drains). The iterator stays a direct queue passthrough — wrapping it in an async generator would add a per-item microtask that reorders delivery for latency-sensitive consumers.
- New `AsyncQueue.take(signal?)`: a cancellable single-step dequeue with the iterator's exact contract (pause, drain-then-throw after `fail()`). Aborting removes the parked waiter atomically inside the queue, so a cancelled `take()` can never swallow an item — unlike racing `iterator.next()` with a promise combinator, which leaves the underlying `next()` pending. Compose a bounded wait at the call site with `linkSignals(signal, AbortSignal.timeout(ms))`.
- An event dispatched synchronously from within a transition is now processed after the current transition's state change is applied, instead of being run re-entrantly against the stale (pre-transition) state.
- `close()` now waits for an in-flight drain to finish and drains any tail before sealing the output stream, so outputs from events queued during that drain are not dropped.
