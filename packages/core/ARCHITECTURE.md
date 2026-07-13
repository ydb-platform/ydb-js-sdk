# @ydbjs/core architecture

## Endpoints engine (`src/endpoints/`)

A reference-grade state machine for endpoint management — discovery, routing, and
the connection pool — built on `@ydbjs/fsm`. It is intended to replace the ad-hoc
`pool.ts` / discovery loop in a later step; today it is a standalone, fully-tested
module not yet wired into `Driver`.

### Files

| File                    | Role                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `endpoints-state.ts`    | Pure FSM: states, context, events/effects/outputs, `endpointsTransition`. No I/O.                                              |
| `snapshot.ts`           | Pure `RoutingSnapshot` + `buildSnapshot` + `selectEndpoint` (the selection cascade).                                           |
| `endpoints-runtime.ts`  | Effectful `EndpointPool` facade + `createEndpointsRuntime`. Owns discovery, gRPC channels, timers, the clock, and diagnostics. |
| `endpoints.fixtures.ts` | Test scaffolding (fake discovery + drivable fake channels).                                                                    |

### RCU two-plane

The **control plane** (the async FSM) owns the discovery lifecycle, the endpoint
registry, and health. On any change to the routable set it rebuilds an **immutable
`RoutingSnapshot`** and emits it. The **data plane** — the synchronous `acquire()` /
`acquireNode()` — reads the latest snapshot reference (swapped by `#consume`),
selects a `RoutingSnapshot` ref (pure), and lazily materializes a channel. The only
per-RPC dispatch is a fire-and-forget `report()` (enqueue only; handled off the hot
path). Reads never dispatch; writes never happen inline. `#channels` / `#retired` /
`#pinned` are facade-owned I/O the transition never touches — that is what makes the
sync hot path race-free against the async FSM.

### States (discovery lifecycle)

`idle → discovering → ready ⇄ degraded → closing → closed`

Per-endpoint health is **not** a machine state — it is a `subState`
(`active | pessimized | retired | pinned`) on a `Map<nodeId, EndpointEntry>` in the
context, so a 10k-node cluster is one machine with two maps.

### Transition table

Global guard: `endpoints.destroy` from any non-terminal state → `closed` (immediate).

| State          | Event                                            | →                | Notes                                                           |
| -------------- | ------------------------------------------------ | ---------------- | --------------------------------------------------------------- |
| idle           | discovery.start                                  | discovering      | run first round                                                 |
| idle           | pin / invalidate                                 | idle             | rebuild snapshot                                                |
| idle           | close                                            | closed           | close-before-start                                              |
| discovering    | round_succeeded                                  | ready / degraded | apply round, ready-latch, arm interval+idle_sweep               |
| discovering    | round_failed (retryable)                         | discovering      | arm backoff, stay                                               |
| discovering    | round_failed (non-retryable)                     | closed           | emit `failed` (only terminal-failure path)                      |
| discovering    | timer.discovery_backoff                          | discovering      | run round                                                       |
| discovering    | close                                            | closing/closed   | graceful drain                                                  |
| ready/degraded | round_succeeded                                  | ready / degraded | apply round (revive/add/retire + blanket un-ban)                |
| ready/degraded | round_failed                                     | ready/degraded   | background failure is **never** terminal; arm backoff           |
| ready/degraded | discovery.force / timer.interval / timer.backoff | —                | single-flight (dropped while a round is in flight)              |
| ready/degraded | rpc_failed                                       | ready / degraded | ban active→pessimized; force a round if `>threshold` pessimized |
| ready/degraded | rpc_ok                                           | ready / degraded | optimistic un-ban pessimized→active                             |
| ready/degraded | timer.idle_sweep                                 | —                | emit idle_sweep effect                                          |
| ready/degraded | channel_closeable                                | —                | drop a retired channel, emit `removed{idle}`                    |
| ready/degraded | pin / invalidate                                 | —                | update pins, rebuild snapshot                                   |
| ready/degraded | close                                            | closing/closed   | graceful drain                                                  |
| closing        | channel_closeable                                | closing/closed   | close a drained channel; finalize when empty                    |
| closing        | timer.close_deadline                             | closed           | force-close the rest                                            |
| closed         | \*                                               | closed           | ignored                                                         |

**Snapshot rebuild** fires only when the routable set changes (add / remove / ban /
un-ban / retire / pin) — never on `rpc_ok` of an already-active node — so RCU emission
tracks topology change, not RPC volume.

### Selection cascade (`selectEndpoint`)

`pile_states` empty ⇒ **no pile filter (identity — the non-bridge default)**.

0. **hard-pin** — direct-IO exact node or `undefined` (never substitutes).
1. **soft affinity** — `byNodeId.get(preferNodeId)`; returns even a pessimized node so
   a node-bound session errors explicitly instead of landing elsewhere.
2. healthy **prefer** (local, or all-healthy when locality is off) — uniform random.
3. healthy **fallback** (remote) — uniform random.
4. any **active** (pile-relaxed) — last resort.
5. **pessimized** — last resort.
6. `undefined` → the facade throws `EndpointsUnavailableError`.

### Balancing / pessimization / discovery decisions

- **Uniform random within the best-locality tier** (not round-robin). Locality is
  opt-in and soft-only. `load_factor` is surfaced for observability but never routed
  on (the server hardcodes it to `0.0`).
- **Pessimization has no fixed timer.** A node is banned on a reported transport
  failure and recovered by an optimistic un-ban on the next successful RPC or a
  blanket un-ban on any successful discovery round.
- **Discovery** keeps a steady background interval plus a degradation-triggered
  forced round (`> threshold` pessimized), single-flight, with equal-jitter backoff.
  An initial failure is retryable (stays `discovering`); only a non-retryable error is
  terminal.

### Retired-connection lifecycle (churn-avoidance)

A connection dropped from discovery is **not** torn down while it works: live streams
drain on it and a brief flap does not close it. New RPCs are simply not routed there.
The `idle_sweep` effect closes a retired channel only on genuine breakage
(`SHUTDOWN` / sustained `TRANSIENT_FAILURE`) or after `retiredGraceMs` idle with no
reappearance; a returning node revives the **same** channel. Still-discovered channels
are never proactively closed — grpc-js manages their idle socket.

### Direct topic IO

Three primitives: `pin(nodeId, host, port)`, `acquireNode(nodeId, {hard})`, and
`invalidate(nodeId)`, over a `#pinned` map **outside** the balanced tiers. Generation
tracking and the two-stream ordered-ack protocol live in the topic-reader FSM, not
here.

### Diagnostics

The FSM is diagnostics-agnostic — it emits typed outputs. The facade republishes them
to `ydb:driver.connection.added/removed/pessimized/unpessimized/retired`,
`ydb:driver.discovery.completed`, `ydb:driver.ready/failed/closed`,
`tracing:ydb:driver.discovery`, and the `DriverHooks`. Because pessimization dropped
the fixed timer, `ydb:driver.connection.pessimized` no longer carries an `until` field.
