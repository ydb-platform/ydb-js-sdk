# @ydbjs/telemetry

> ⚠️ **This README is an implementation guide for the developer building this package.**
> It is **not** end-user documentation — public docs live in the website and the
> per-package READMEs of `@ydbjs/core`, `@ydbjs/query`, `@ydbjs/auth`, `@ydbjs/retry`.
>
> Purpose of this file: lock in the contract, the architecture, and the open
> questions so the implementor can ship the package without having to re-derive
> any of the design decisions.

OpenTelemetry instrumentation for `@ydbjs/*` packages. Subscribes to
`node:diagnostics_channel` events published by core, query, auth, and retry,
and emits **traces**, **metrics**, and **logs** through `@opentelemetry/api`.

---

## Scope and non-goals

### In scope

- Subscribers for **every channel** declared in `@ydbjs/core`, `@ydbjs/query`,
  `@ydbjs/auth`, `@ydbjs/retry`. The full list is in [§3](#3-channel-contract).
- Three signals: traces (spans), metrics (counters / histograms / gauges),
  logs (structured records).
- Programmatic registration: `register({...})` returning a disposer.
- Auto-instrumentation entry: `node --import @ydbjs/telemetry/register` —
  pattern from `@opentelemetry/auto-instrumentations-node`.
- Resource attribute defaults: `db.system.name = 'ydb'`,
  `db.namespace = <database>`, `server.address = <endpoint>`.
- **Safe subscribers**: a thrown exception in any handler must not propagate
  back into SDK code. See [§5.2](#52-safe-subscribers).

### Out of scope

- **Channels for `@ydbjs/topic`** — separate package, separate PR.
- **Channels for `@ydbjs/coordination`** — separate PR.
- **gRPC RPC-level tracing** — produces noise from discovery / keepalive,
  not useful in production.
- **Any change to SDK internals.** This package is subscriber-only. If you
  feel you need to reach into a private field — open an issue against the
  publishing package to expose the data via channel payload instead.
- **No `@opentelemetry/*` imports outside this package.** SDK packages stay
  vendor-neutral; OTel is a peer dep here only.
- **No monkey-patching.** The SDK exposes everything we need via channels.

---

## 1. Architecture

### 1.1. Why diagnostics_channel and not direct OTel calls

`@ydbjs/*` packages publish domain events through `node:diagnostics_channel`.
This package is a **subscriber** — it identifies channels by **name**, not by
imported objects. Channel names are the public contract; renaming any of them
is a SemVer major.

This indirection gives us:

- **Vendor neutrality.** Datadog APM, Sentry, Pino, custom subscribers attach
  to the same names. No fork in the SDK.
- **Zero cost when nobody listens.** `tracingChannel.tracePromise` short-circuits
  on `hasSubscribers`. Plain `channel.publish` is one map lookup.
- **No version coupling.** SDK and telemetry release independently. Two
  copies of either in `node_modules` still see the same global channels.

### 1.2. Two channel primitives, two roles

| Primitive | When to use it | What we build from it |
|---|---|---|
| `tracingChannel(name)` | Operation with a duration and a possible failure (`start` → `asyncEnd` / `error`) | One **span** + duration **histogram** + error **counter** |
| `channel(name).publish(p)` | Discrete state change with no duration | **Counter** / **gauge delta** + **log record** |

This is the same matrix the SDK side uses when deciding which primitive to
expose; we mirror it on the consumer side.

### 1.3. Context propagation through transaction bodies

The trickiest part of the implementation. Read this carefully before writing
code — the OTel API has a footgun here.

A user wrote this:

```ts
await tracer.startActiveSpan('handle-request', async (root) => {
    await sql.begin(async (tx) => {
        await tx`select 1`             // must be child of ydb.Transaction
        await tx`select 1`             // same
        await doBusinessLogic()        // its OTel ops must also be children
    })
})
```

Required span tree:

```
handle-request
└── ydb.Transaction
    ├── ydb.Query.execute (select 1)
    ├── ydb.Query.execute (select 1)
    └── …spans from doBusinessLogic…
```

For the inner spans to attach to `ydb.Transaction` automatically,
`context.active()` must return the tx OTel context **for the entire async chain
of the user callback**, including everything reached through `await`.

#### How `tracingChannel` enables this

`tracePromise(fn, ctx)` calls `start.runStores(ctx, fn)` under the hood. The
body executes inside `runStores`, so any `AsyncLocalStorage` bound via
`channel.bindStore(als, transform)` is active for every `await` reached from
`fn`.

The standard OTel context manager (`AsyncLocalStorageContextManager`) keeps its
ALS in a private field. Two viable approaches:

**Approach A — register our own context manager backed by an ALS we control.**

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { context as otelContext, ROOT_CONTEXT, type Context } from '@opentelemetry/api'

let als = new AsyncLocalStorage<Context>()

class AlsContextManager {
    active() { return als.getStore() ?? ROOT_CONTEXT }
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
        ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A
    ): ReturnType<F> {
        return als.run(ctx, fn.bind(thisArg) as F, ...args)
    }
    bind<T>(_ctx: Context, target: T): T { return target }
    enable() { return this }
    disable() { return this }
}

otelContext.setGlobalContextManager(new AlsContextManager())
```

Then bind the same ALS to the `:start` subchannel:

```ts
import diagnostics_channel from 'node:diagnostics_channel'
import { trace, context } from '@opentelemetry/api'

diagnostics_channel
    .channel('tracing:ydb:query.transaction:start')
    .bindStore(als, (ctx: any) => {
        let span = tracer.startSpan('ydb.Transaction', { /* … */ })
        ctx.span = span
        return trace.setSpan(context.active(), span)
    })
```

After this, `tx`select 1`` inside the callback finds `ydb.Transaction` via
`context.active()` and creates `ydb.Query.execute` as its child without any
explicit parent linking.

**Approach B — only register if no manager is set, otherwise piggyback.**

If `setGlobalContextManager` was already called by user code (e.g. via
`NodeTracerProvider`), we must not overwrite it. Detection is awkward — the
API has no getter — so the simplest contract is: `register()` may install a
context manager; if you want a different one, install yours **before** calling
`register()`. Document this clearly in the user-facing README.

#### What does **not** work

- ❌ Reading `trace.getActiveSpan()` in `asyncEnd` / `end` to find "our" span.
  By that point the user's active context may already be lost. Always use a
  `WeakMap<ctx, Span>` (or `ctx.span = …`) populated in `start`.
- ❌ Wrapping the body in `context.with(...)` from a subscriber. The body has
  already begun executing by the time `start` returns; there is nowhere to
  wrap.
- ❌ Calling `trace.getActiveSpan()` to find the **parent**. `tracer.startSpan`
  in the `start` handler picks parent from `context.active()` automatically,
  because `start` runs synchronously within the caller's stack.

### 1.4. Span correlation across handlers

Within one `tracingChannel` operation we get five callbacks (`start`,
`asyncStart`, `asyncEnd`, `error`, `end`) that all receive **the same `ctx`
object**. Use this to thread state:

```ts
let spans = new WeakMap<object, Span>()  // alternatively: store on ctx

execCh.subscribe({
    start(ctx)       { spans.set(ctx, tracer.startSpan('ydb.Query.execute')) },
    error(ctx)       { spans.get(ctx)?.recordException(ctx.error as Error) },
    asyncEnd(ctx)    { spans.get(ctx)?.end() },
})
```

`WeakMap` is preferred over `ctx.span = …` so we don't pollute the SDK's
public payload contract. If multiple subscribers run on the same channel
(e.g. ours + a Datadog tracer), each keeps its own `WeakMap`.

---

## 2. Package layout

```text
packages/telemetry/
├── src/
│   ├── index.ts                # register(), Disposer, public types
│   ├── register.ts             # entry for `node --import …/register`
│   ├── context-manager.ts      # AlsContextManager, ALS wiring
│   ├── tracing/
│   │   ├── driver.ts           # ydb:driver.* subscribers
│   │   ├── discovery.ts
│   │   ├── pool.ts             # ydb:pool.connection.*
│   │   ├── session.ts          # tracing:ydb:session.*, ydb:session.*
│   │   ├── query.ts            # tracing:ydb:query.execute, .transaction
│   │   ├── retry.ts            # tracing:ydb:retry.*
│   │   └── auth.ts
│   ├── metrics/
│   │   ├── pool.ts
│   │   ├── session.ts
│   │   ├── query.ts
│   │   ├── retry.ts
│   │   └── auth.ts
│   ├── logs/
│   │   └── lifecycle.ts        # severity-mapped log records
│   ├── attributes.ts           # OTel semconv mapping helpers
│   └── safe.ts                 # safeSubscribe / safeTracingSubscribe wrappers
├── test/
│   ├── traces.test.ts
│   ├── metrics.test.ts
│   ├── logs.test.ts
│   └── propagation.test.ts     # tx → query parent-child via ALS
└── README.md                   # ← you are here
```

One file per logical channel group. `register()` is a thin assembler:

```ts
export function register(options: RegisterOptions = {}): Disposer {
    let disposers: Array<() => void> = []
    if (options.contextManager !== false) disposers.push(installContextManager())
    if (options.traces ?? true)  disposers.push(...installTracing(options))
    if (options.metrics ?? true) disposers.push(...installMetrics(options))
    if (options.logs ?? false)   disposers.push(...installLogs(options))
    return () => disposers.forEach(d => d())
}
```

`register()` must be **idempotent** — calling twice returns a disposer that
cleans up the second registration only. The first remains active. Test this.

---

## 3. Channel contract

This is the locked-in contract from the PR #596 review. **Do not invent new
fields or rename anything without coordinating an SDK PR first** — these names
and payloads are SemVer-stable public API.

### 3.1. Driver lifecycle (`@ydbjs/core`)

| Channel | Type | Context / payload |
|---|---|---|
| `tracing:ydb:driver.init` | tracing | `{ database: string, endpoint: string, discovery: boolean }` |
| `ydb:driver.ready` | publish | `{ database: string, duration: number }` |
| `ydb:driver.closed` | publish | `{ database: string, uptime: number }` |

### 3.2. Discovery (`@ydbjs/core`)

| Channel | Type | Context / payload |
|---|---|---|
| `tracing:ydb:discovery` | tracing | `{ database: string, periodic: boolean }` |
| `ydb:discovery.completed` | publish | `{ database: string, addedCount: number, removedCount: number, totalCount: number, duration: number }` |

### 3.3. Connection pool (`@ydbjs/core`)

| Channel | Type | Context / payload |
|---|---|---|
| `ydb:pool.connection.added` | publish | `{ nodeId: bigint, address: string, location: string }` |
| `ydb:pool.connection.removed` | publish | `{ nodeId: bigint, address: string, location: string, reason: 'discovery.stale_active' \| 'discovery.stale_pessimized' }` |
| `ydb:pool.connection.pessimized` | publish | `{ nodeId: bigint, address: string, until: number }` |
| `ydb:pool.connection.unpessimized` | publish | `{ nodeId: bigint, address: string, pessimizedDuration: number }` |

### 3.4. Session pool (`@ydbjs/query`)

| Channel | Type | Context / payload |
|---|---|---|
| `tracing:ydb:session.acquire` | tracing | `{ kind: 'query' \| 'transaction' }` |
| `tracing:ydb:session.create` | tracing | `{ liveSessions: number, maxSize: number, creating: number }` |
| `ydb:session.created` | publish | `{ sessionId: string, nodeId: bigint }` |
| `ydb:session.closed` | publish | `{ sessionId: string, nodeId: bigint, reason: 'evicted' \| 'pool_close' \| 'released_dead', uptime: number }` |
| `ydb:session.pool.exhausted` | publish | `{ liveSessions: number, waiters: number }` |
| `ydb:session.pool.queued` | publish | `{ liveSessions: number, position: number }` |

> The single `session.closed` channel with `reason` replaces the earlier
> `evicted` / `destroyed` split. Do not subscribe to the old names — they will
> not exist in the released contract.

### 3.5. Query execution (`@ydbjs/query`)

| Channel | Type | Context / payload |
|---|---|---|
| `tracing:ydb:query.execute` | tracing | `{ text: string, sessionId: string, nodeId: bigint, idempotent: boolean, isolation: string \| 'implicit', stage: 'standalone' \| 'tx' \| 'do' }` |
| `tracing:ydb:query.transaction` | tracing | `{ isolation: string, idempotent: boolean }` |
| `ydb:query.attempt.started` | publish | `{ kind: 'query' \| 'transaction', attempt: number, idempotent: boolean }` |
| `ydb:query.metadata` | publish | `{ sessionId: string, trailers: Record<string, string> }` |
| `ydb:query.stats` | publish | `{ sessionId: string, stats: QueryStats }` (type from `@ydbjs/api`) |

### 3.6. Auth (`@ydbjs/auth`)

| Channel | Type | Context / payload |
|---|---|---|
| `tracing:ydb:auth.token.fetch` | tracing | `{ provider: 'static' \| 'metadata' \| 'iam' \| 'access_token' \| 'anonymous' }` |
| `ydb:auth.token.refreshed` | publish | `{ provider: string, expiresAt: number }` |
| `ydb:auth.token.expired` | publish | `{ provider: string, stalenessMs: number }` |
| `ydb:auth.provider.failed` | publish | `{ provider: string, error: unknown }` |

> `auth.token.expired` fires **once per incident**, not once per call hitting
> a stale cache. `expiresAt` is unix milliseconds across all providers.

### 3.7. Retry (`@ydbjs/retry`)

| Channel | Type | Context / payload |
|---|---|---|
| `tracing:ydb:retry.run` | tracing | `{ idempotent: boolean }` |
| `tracing:ydb:retry.attempt` | tracing | `{ attempt: number, idempotent: boolean }` |
| `ydb:retry.exhausted` | publish | `{ attempts: number, totalDuration: number, lastError: unknown }` |

These are published from inside `retry()` itself, so every consumer of the
retry library (driver discovery, query, transaction, auth token fetch) gets
spans uniformly. Do **not** subscribe to per-package retry events — there are
none.

---

## 4. Mapping channels to OTel signals

### 4.1. Span tree shape

This is what we want to render in Jaeger / Tempo for a typical retried
transaction with two queries:

```text
handle-request                                     (user code)
└── ydb.Transaction                                tracing:ydb:query.transaction
    └── ydb.Retry.run                              tracing:ydb:retry.run
        ├── ydb.Retry.attempt (1, error)           tracing:ydb:retry.attempt
        │   ├── ydb.Session.acquire                tracing:ydb:session.acquire
        │   │   └── ydb.Session.create [if grew]   tracing:ydb:session.create
        │   ├── ydb.Query.execute (BEGIN)          tracing:ydb:query.execute
        │   ├── ydb.Query.execute (SELECT)
        │   └── ydb.Query.execute (COMMIT)
        └── ydb.Retry.attempt (2)
            ├── ydb.Session.acquire
            ├── ydb.Query.execute (BEGIN)
            ├── ydb.Query.execute (SELECT)
            └── ydb.Query.execute (COMMIT)
```

Span names use `ydb.<Domain>.<Operation>` PascalCase. Channel names use
snake-with-dots — different conventions for different layers.

### 4.2. Metrics catalogue

| Metric | Type | Source |
|---|---|---|
| `ydb.driver.up` | gauge (observable) | `driver.ready` count − `driver.closed` count |
| `ydb.driver.startup.duration` | histogram | `tracing:ydb:driver.init` (asyncEnd − start) |
| `ydb.discovery.duration` | histogram | `tracing:ydb:discovery` |
| `ydb.discovery.endpoints` | gauge (observable) | `ydb:discovery.completed.totalCount` |
| `ydb.pool.connections.active` | gauge (observable up-down) | delta from `pool.connection.{added,removed,pessimized,unpessimized}` |
| `ydb.pool.connections.pessimized` | gauge (observable up-down) | delta from `pool.connection.{pessimized,unpessimized,removed}` |
| `ydb.session.pool.size` | gauge (observable up-down) | delta from `session.{created,closed}` |
| `ydb.session.acquire.duration` | histogram | `tracing:ydb:session.acquire` |
| `ydb.session.create.duration` | histogram | `tracing:ydb:session.create` |
| `ydb.session.pool.exhausted` | counter | `ydb:session.pool.exhausted` |
| `ydb.query.duration` | histogram | `tracing:ydb:query.execute`, labels: `isolation`, `idempotent`, `stage` |
| `ydb.query.errors` | counter | `tracing:ydb:query.execute` error subchannel, label: `error.type` |
| `ydb.tx.duration` | histogram | `tracing:ydb:query.transaction` |
| `ydb.retry.attempts` | histogram | per-`retry.run` count of `retry.attempt` events |
| `ydb.retry.exhausted` | counter | `ydb:retry.exhausted` |
| `ydb.auth.token.refresh.duration` | histogram | `tracing:ydb:auth.token.fetch` |
| `ydb.auth.token.expired` | counter | `ydb:auth.token.expired` |
| `ydb.auth.provider.failed` | counter | `ydb:auth.provider.failed` |

#### Reconstructing pool state from deltas

We do **not** require any public getter on the pool. Active / pessimized /
session counts are reconstructed by accumulating delta events and exposing
them as observable up-down counters:

```ts
let active = 0
let pessimized = 0

meter.createObservableUpDownCounter('ydb.pool.connections.active')
    .addCallback(r => r.observe(active))

dc.subscribe('ydb:pool.connection.added',        () => active++)
dc.subscribe('ydb:pool.connection.removed',      () => active--)
dc.subscribe('ydb:pool.connection.pessimized',   () => { active--; pessimized++ })
dc.subscribe('ydb:pool.connection.unpessimized', () => { active++; pessimized-- })
```

This keeps the pool's internals private and gives us freedom to refactor pool
implementation without breaking the metrics contract.

### 4.3. Logs catalogue

Every `channel.publish` event becomes a structured log record. Severity:

| Pattern | Severity |
|---|---|
| `ydb:driver.ready`, `ydb:*.created`, `ydb:*.added` | INFO |
| `ydb:auth.token.refreshed`, `ydb:pool.connection.unpessimized` | DEBUG |
| `ydb:auth.token.expired`, `ydb:pool.connection.pessimized`, `ydb:session.closed`, `ydb:pool.connection.removed` | DEBUG / INFO |
| `ydb:auth.provider.failed`, `ydb:retry.exhausted`, `ydb:driver.closed` | WARN |

`tracingChannel` `error` events emit ERROR-level logs with the exception
attached and `trace_id` / `span_id` set, so backends correlate logs ↔ traces.

Logs are **off by default** (`logs: false` in `register()`) — most users send
logs through their own pipeline and don't want duplicates from telemetry.

### 4.4. Semantic attributes

We follow [OTel database semconv](https://opentelemetry.io/docs/specs/semconv/database/)
where it applies. YDB-specific attributes go under `db.ydb.*`.

| OTel attribute | Source |
|---|---|
| `db.system.name` | constant `'ydb'` |
| `db.namespace` | YDB database path (from driver init payload) |
| `db.query.text` | `query.execute.text` — **opt-in via `captureQueryText`** |
| `db.operation.name` | `'ExecuteQuery'`, `'Transaction'`, `'CreateSession'`, … |
| `error.type` | exception class name on `error` callback |
| `server.address` | endpoint host:port |
| `network.peer.address` | resolved address |

| YDB-specific | Source |
|---|---|
| `db.ydb.session_id` | `query.execute.sessionId` |
| `db.ydb.node_id` | `query.execute.nodeId` (Number(bigint)) |
| `db.ydb.tx.isolation` | `query.transaction.isolation` |
| `db.ydb.idempotent` | `*.idempotent` |
| `db.ydb.attempt` | `retry.attempt.attempt` |
| `db.ydb.location` | `pool.connection.*.location` |

---

## 5. Implementation rules

### 5.1. PII: query text is opt-in

`db.query.text` contains raw SQL with `DECLARE` lines for every parameter —
the parameter values themselves are not in the channel payload (they live in
the gRPC message), but the **schema** is. Some users still consider this PII.

```ts
register({ captureQueryText: false })   // default
register({ captureQueryText: true })    // opt-in
```

When disabled, set `db.query.text` to a constant `'<redacted>'` rather than
omitting it — span attribute presence is itself a signal in some backends.

### 5.2. Safe subscribers

`node:diagnostics_channel` calls subscribers **synchronously**. A throw inside
our handler propagates back into SDK code via the call stack and can break
discovery / pool / driver. Wrap every subscriber:

```ts
import { loggers } from '@ydbjs/debug'

let dbg = loggers.error.extend('telemetry')

export function safeSubscribe(name: string, fn: (msg: any) => void): () => void {
    let safe = (msg: unknown) => {
        try { fn(msg) }
        catch (err) { dbg.log('subscriber for %s threw: %O', name, err) }
    }
    let ch = diagnostics_channel.channel(name)
    ch.subscribe(safe)
    return () => ch.unsubscribe(safe)
}

export function safeTracingSubscribe<T>(
    name: string,
    handlers: TracingChannelSubscribers<T>,
): () => void {
    let wrapped = Object.fromEntries(
        Object.entries(handlers).map(([k, fn]) => [k, (ctx: T) => {
            try { (fn as Function)(ctx) }
            catch (err) { dbg.log('%s.%s threw: %O', name, k, err) }
        }]),
    ) as TracingChannelSubscribers<T>
    let tc = diagnostics_channel.tracingChannel<string, T>(name)
    tc.subscribe(wrapped)
    return () => tc.unsubscribe(wrapped)
}
```

Use these everywhere in `src/tracing/`, `src/metrics/`, `src/logs/`. Never
call `dc.subscribe`/`tc.subscribe` directly.

### 5.3. `hasSubscribers` is not our problem

Don't bother gating on `ch.hasSubscribers` from the consumer side — the
tracingChannel API already short-circuits, and for plain channels, if we are
the subscriber, the answer is always true. `hasSubscribers` is a **publisher**
concern.

### 5.4. Idempotent registration

Calling `register()` twice must not double-count metrics or duplicate spans.
Track installed state internally; second call returns a no-op disposer (or
disposer that removes only the second registration).

### 5.5. No re-export of SDK channels

Don't import `sessionAcquireCh` (or any other channel object) from
`@ydbjs/query` even if the publisher accidentally exports it. Always go
through the global registry by name:

```ts
diagnostics_channel.tracingChannel('tracing:ydb:session.acquire')
```

This keeps the contract one-way (names only) and lets us swap or move publish
points without breaking consumers.

### 5.6. Type-only payload imports

If the SDK exposes payload types via `@ydbjs/<pkg>/diagnostics`, import them
as type-only:

```ts
import type { QueryExecuteContext } from '@ydbjs/query/diagnostics'
```

This gives us type safety without creating a runtime dependency. If a
publisher does not expose types yet, declare the shape locally in
`src/attributes.ts` and add a TODO referencing the channel name.

---

## 6. Configuration

### 6.1. Programmatic

```ts
register({
    traces:           true,           // default
    metrics:          true,           // default
    logs:             false,          // default
    contextManager:   true,           // install AlsContextManager if none set
    captureQueryText: false,          // PII: include db.query.text
    attributePrefix:  'db.ydb',       // ydb-specific attribute namespace
    serviceName:      undefined,      // resource attribute service.name
})
```

Returns a `Disposer` (`() => void`). Calling it removes all subscribers and
detaches the context manager (only if we installed it).

### 6.2. Environment variables

Read in `register.ts` for the auto-instrumentation path:

| Variable | Default | Effect |
|---|---|---|
| `YDB_TELEMETRY_TRACES` | `true` | Emit spans |
| `YDB_TELEMETRY_METRICS` | `true` | Emit metrics |
| `YDB_TELEMETRY_LOGS` | `false` | Emit log records |
| `YDB_TELEMETRY_QUERY_TEXT` | `false` | Include `db.query.text` |
| `YDB_TELEMETRY_SAMPLER` | `parent` | `parent` / `always_on` / `always_off` |

Standard OTel envs (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_*`) are honored
automatically by the user's OTel SDK — don't reimplement them here.

### 6.3. Auto-instrumentation entry

```sh
node --import @ydbjs/telemetry/register app.js
```

Implementation: `src/register.ts` calls `register()` with env-derived options.
Side-effecting import.

---

## 7. Testing strategy

### 7.1. Unit tests

For each subscriber, two tests minimum:

1. **Happy path.** Publish a synthetic payload, assert span / metric / log
   recorded the expected attributes and counts.
2. **Subscriber-throw safety.** Inject a handler that throws (e.g. mock
   `tracer.startSpan` to throw), publish, assert the SDK call site does
   **not** throw — only `loggers.error` was hit.

Use `InMemorySpanExporter`, `InMemoryMetricExporter` from
`@opentelemetry/sdk-trace-base` / `sdk-metrics` for assertions.

### 7.2. Integration test: tx → query parent-child

This is the hardest case to get right. Required test:

```ts
test('inner queries inside sql.begin become children of ydb.Transaction', async () => {
    let exporter = new InMemorySpanExporter()
    let provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    provider.register()
    register()

    let tracer = trace.getTracer('test')
    await tracer.startActiveSpan('root', async (root) => {
        await sql.begin(async (tx) => {
            await tx`select 1`
            await tx`select 2`
        })
        root.end()
    })

    let spans = exporter.getFinishedSpans()
    let txSpan = spans.find(s => s.name === 'ydb.Transaction')!
    let queries = spans.filter(s => s.name === 'ydb.Query.execute')

    expect(queries).toHaveLength(2)
    for (let q of queries) {
        expect(q.parentSpanId).toBe(txSpan.spanContext().spanId)
    }
})
```

If this test passes, the ALS / context manager wiring is correct. If it
fails, queries appear as siblings or roots, and §1.3 needs revisiting.

### 7.3. Idempotent register test

```ts
test('register() twice does not double-emit spans', async () => {
    register()
    register()
    await sql`select 1`
    expect(exporter.getFinishedSpans().filter(s => s.name === 'ydb.Query.execute'))
        .toHaveLength(1)
})
```

---

## 8. Implementation roadmap

Build in the order below — each milestone is independently shippable.

1. **MVP: query traces.** Subscribers for `tracing:ydb:query.execute` and
   `tracing:ydb:query.transaction`. Custom context manager. ALS propagation
   test passes. Ship as `0.1.0` (alpha).
2. **+ retry, session.acquire.** Adds `retry.run`, `retry.attempt`,
   `session.acquire`, `session.create`. Span tree from §4.1 fully realized.
3. **+ pool & discovery metrics.** Active connections gauge, discovery
   duration histogram, pool exhaustion counter.
4. **+ auth.** Token refresh latency, expired counter, provider failure
   counter.
5. **+ logs.** Severity-mapped log records for all publish channels.
6. **+ auto-instrumentation.** `node --import` entry, env vars, default
   resource attributes.
7. **Beta release.** Gather feedback from internal users, finalize public
   user-facing README.
8. **GA.** SemVer 1.0, channel contract frozen.

---

## 9. References

- PR #596 — initial publish-points contract and review thread (read this in
  full before starting).
- [Node.js diagnostics_channel docs](https://nodejs.org/api/diagnostics_channel.html)
- [OTel JS API](https://github.com/open-telemetry/opentelemetry-js-api)
- [OTel database semconv](https://opentelemetry.io/docs/specs/semconv/database/)
- [`@opentelemetry/instrumentation-undici`](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/node/instrumentation-undici)
  — closest existing example of a diagnostics_channel-based OTel
  instrumentation.

---

## 10. Open questions

Track these as GitHub issues before merging the first implementation:

- **Should we expose a public `Disposer` type?** Returning `() => void` is
  simplest; a class with `[Symbol.dispose]` is more idiomatic for `using`.
- **Should `register()` accept a custom `Tracer` / `Meter` / `Logger`?**
  Useful for tests; default is `trace.getTracer('@ydbjs/telemetry', VERSION)`.
- **Sampling defaults.** Default to parent-based, but consider rate-limited
  sampling for `ydb.Query.execute` — high-throughput apps will generate a
  lot of spans.
- **Cardinality of `db.query.text`.** Even when opt-in, raw text blows up
  cardinality on metric labels. Document that `db.query.text` goes on spans
  only, never as a metric label.
- **Resource detection.** Should we read driver metadata (database, endpoint)
  from `tracing:ydb:driver.init` and feed it as resource attributes? Resource
  attributes are static per-process; driver init happens after process start.
  Workaround: set them lazily on first use.
