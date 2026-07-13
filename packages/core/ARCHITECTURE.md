# @ydbjs/core architecture

## Endpoints engine (`src/endpoints/`)

A reference-grade state machine for endpoint management — discovery, routing, and
the connection pool — built on `@ydbjs/fsm`. It replaces the legacy `ConnectionPool`
and the Driver's ad-hoc discovery loop: `Driver` owns a bootstrap connection + the
middleware chain and hands the engine a `listEndpoints` seam (see `driver.ts`); the
`BalancedChannel` (see `channel.ts`) routes each RPC through `EndpointPool.acquire()`
and reports outcomes via `EndpointPool.report()`.

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
| ready/degraded | close                                            | closing/closed   | freeze routing, begin drain (immediate if nothing registered)   |
| closing        | channel_closeable                                | closing/closed   | close a drained channel; finalize when the last one goes        |
| closing        | timer.close_deadline                             | closed           | force-close the rest                                            |
| closed         | \*                                               | closed           | ignored                                                         |

On `close`, routing is frozen (an empty snapshot is emitted so `acquire()` throws
rather than vending a channel), then the runtime's `begin_close_drain` effect
closes every idle channel at once and registers the busy ones. A busy channel is
finalized as soon as its in-flight RPCs drain (`BalancedChannel` tracks an
in-flight count per node); `close_deadline` is the hard cap. So `await using
driver` returns immediately when nothing is in flight instead of always waiting
the deadline.

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

The engine is **internal** — consumers only ever hold a `Driver`. Direct-IO is
reached through `Driver.createClient(service, target)`:

- `createClient(service)` — balanced across all healthy nodes.
- `createClient(service, nodeId)` — soft affinity (node-bound query sessions).
- `createClient(service, { nodeId, endpoint?, hard? })` — direct-IO. With
  `hard: true` every RPC goes to `nodeId` or fails (never substitutes). With
  `endpoint` the node is **pinned** (reachable before the next discovery round,
  for a server-named node from a topic `PartitionLocation`); the returned client
  is `Disposable` and unpins on dispose.

Internally these map to the pool primitives `pin(nodeId, host, port, {generation})`,
`acquireNode(nodeId, {hard})`, and `invalidate(nodeId)`, over a `#pinned` map
**outside** the balanced tiers. Generation tracking and the two-stream ordered-ack
protocol live in the topic-reader FSM, not here.

### Diagnostics

The FSM is diagnostics-agnostic — it emits typed outputs. The facade republishes them
to `ydb:driver.connection.added/removed/pessimized/unpessimized/retired`,
`ydb:driver.discovery.completed`, `ydb:driver.ready/failed/closed`,
`tracing:ydb:driver.discovery`, and the `DriverHooks`. The round-derived events
(`connection.added` / `connection.retired` / `discovery.completed`) are published from
inside the discovery `tracePromise` callback — the async output-consumer loop has no
active span, so publishing them there would drop them from traces. A reappearing
(revived) retired node re-emits `connection.added` so add/remove event streams stay
balanced. Because pessimization dropped the fixed timer, `ydb:driver.connection.pessimized`
no longer carries an `until` field.
