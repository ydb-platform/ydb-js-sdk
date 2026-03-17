# @ydbjs/fsm — Design Document

## Overview

`@ydbjs/fsm` is a reusable runtime for finite state machines used across YDB JS SDK packages (`coordination`, `topic`, `query`, and others).

The package focuses on predictable async behavior in long-lived, failure-prone workflows:

- stream lifecycle management
- reconnect loops
- backoff timers
- cancellation via `AbortSignal`
- deterministic state transitions without races

This package is **not** a framework and **not** a DSL-heavy abstraction. It is a small runtime core with explicit contracts.

---

## Goals

- Provide one shared machine runtime instead of multiple ad-hoc loops
- Eliminate race conditions with single-writer event processing
- Support modern async primitives:
  - `AsyncIterable`
  - `AbortSignal`
  - `AsyncDisposable` (`[Symbol.asyncDispose]`)
- Keep runtime minimal and dependency-free
- Make transitions and side effects easy to test independently

---

## Non-goals

- No visual editor/statechart tooling
- No runtime code generation
- No hidden magic around retries, timers, or transitions
- No opinionated domain model for package-specific states/events

Domain machines remain package-specific. `@ydbjs/fsm` only provides the reusable engine.

---

## Core Architecture

## 1) Single-writer mailbox

All events are appended to one queue and processed sequentially by one loop.

This guarantees:

- no concurrent state mutation
- deterministic transition order
- reproducible behavior in tests

Callbacks from external systems (stream responses, timers, user calls) must never mutate state directly. They only dispatch events.

## 2) Mutable context, pure transition intent

The runtime uses mutable machine context (for low overhead and lower GC pressure).
Transitions are explicit and deterministic.
Side effects are not performed inline in random callbacks; they are triggered from controlled transition handling.

## 3) Effects are explicit

A transition may request effects such as:

- start/stop stream
- send protocol command
- set/cancel timer
- emit lifecycle event
- abort derived resources

Effects are execution instructions, not hidden behavior.

## 4) Async-first I/O model

The runtime integrates with async sources and sinks:

- ingest external `AsyncIterable` event sources
- expose machine-emitted outputs directly through the runtime `AsyncIterable` interface
- cancel ingestion via `AbortSignal`
- support explicit async disposal for clean shutdown

---

## Public Model

The package defines generic machine contracts. Domain packages provide concrete state/event/effect types.

Typical conceptual model:

- `MachineState`: string union
- `MachineEvent`: discriminated union
- `MachineEmitted`: discriminated union
- `MachineContext`: mutable object owned by one machine instance

Machine runtime responsibilities:

- keep current state/context
- accept `dispatch(event)`
- process transitions in order
- run effect handlers
- implement `AsyncIterable<MachineEmitted>` for direct output consumption (`for await ... of runtime`)
- expose `close(reason?)` for graceful shutdown (drain already queued events, then close output stream)
- expose `destroy(reason?)` for hard shutdown (abort runtime signal, drop queued events, close output stream)
- support async disposal as `close()` followed by `destroy()`
- keep runtime surface minimal and hook-free (no lifecycle callback API in the core contract)

---

## Lifecycle Semantics

Each machine instance represents one lifecycle.

The runtime has two shutdown modes:

- `close(reason?)` — graceful shutdown:
  - marks runtime as closing
  - aborts runtime signal so external ingestion sources can stop
  - drains already queued events/effects
  - closes output async stream
- `destroy(reason?)` — hard shutdown:
  - immediately aborts runtime signal
  - clears queued events
  - closes output async stream

After close/destroy terminalization:

- new events are ignored or rejected (per machine policy)
- `ingest(...)` is rejected
- output stream is closed
- lifecycle is not revived

---

## Subscription and Ingestion Model

The runtime supports subscribing to external event streams (e.g. gRPC response stream) via ingestion handles.

Ingestion rules:

- each ingestion has its own cancellation scope
- each ingestion combines its local signal with runtime signal
- ingestion handle is `AsyncDisposable` and should be used with `await using`
- source completion/error is converted into machine behavior, not thrown across arbitrary layers

---

## Error Handling Model

Runtime distinguishes:

- domain errors (machine events such as `*.failure`)
- runtime fatal errors (unexpected transition/effect/ingestion failures)

Fatal runtime errors are handled by immediate runtime termination:

- runtime calls `destroy(error)`
- runtime signal is aborted with terminal reason
- queued events are dropped
- output stream is closed

---

## Determinism and Testing

`@ydbjs/fsm` is designed for deterministic tests:

- transitions are data-driven
- no direct state mutation outside machine loop
- timers can be abstracted/injected
- emitted events can be asserted from iterable output

Recommended testing layers:

1. transition tests (state + event -> next state + requested effects)
2. runtime integration tests (dispatch order, ingestion, disposal)
3. package-level behavior tests (`coordination`, `topic`, `query`)

---

## Integration Strategy Across Packages

## coordination

Use for session lifecycle machine:

- connecting/ready/reconnecting/closing/expired/closed
- stream request/response wiring
- retry/backoff/recovery window timer orchestration
- lifecycle-bound abort propagation

## topic

Reuse same runtime for writer/reader machines where currently state handling is specialized.

## query

Apply selectively for long-lived session/transaction orchestration where race-free transition sequencing is valuable.

---

## Event Naming Convention (recommended)

Use namespaced event types:

- DX-facing: short and user-centric (`session.close`, `writer.flush`)
- stream internals: explicit transport scope (`*.stream.request.*`, `*.stream.response.*`)
- timer/internal: explicit origin (`*.timer.*`, `*.internal.*`)

This keeps domain API readable while preserving protocol-level clarity internally.

---

## Performance Notes

Design choices for runtime efficiency:

- mutable context (no per-event object cloning)
- single queue and single consumer
- no heavy external runtime dependency
- minimal allocations in hot path

Correctness and clarity remain primary. Micro-optimizations must not obscure transition logic.

---

## Security and Safety Notes

The runtime must never:

- log credentials/tokens by default
- swallow terminal errors silently
- leave machine-owned resources undisposed on shutdown

All package integrations must follow existing SDK logging and sensitive-data policies.

---

## Future Extensions (optional)

Potential additions if needed by multiple packages:

- built-in timer scheduler helper
- trace hooks for transition/effect observability
- dev-only transition assertion mode
- transition table introspection for docs/tests

These are optional and must not compromise the minimal runtime core.

---

## Summary

`@ydbjs/fsm` standardizes async machine execution in YDB JS SDK with:

- deterministic single-writer transitions
- explicit effect orchestration
- async iterable integration
- lifecycle-safe disposal and cancellation

It provides a shared runtime foundation while keeping domain behavior in each package explicit and maintainable.
