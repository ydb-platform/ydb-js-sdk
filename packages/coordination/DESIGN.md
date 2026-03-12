# @ydbjs/coordination — Design Document

## Overview

This document describes the API design for the `@ydbjs/coordination` package. The design is based on YDB Coordination Service primitives and covers three layers of abstraction: node management, session/semaphore operations, and high-level recipes (Mutex, Election).

---

## API Hierarchy

```
CoordinationClient
├── Node management        (createNode, alterNode, dropNode, describeNode)
├── createSession()        → CoordinationSession                (single lifecycle, no auto-restart after expiry)
├── openSession()          → AsyncIterable<CoordinationSession> (primary API, yields next lifecycle on expiry)
└── withSession()          → Promise<T>                         (callback helper, one lifecycle per invocation)

CoordinationSession
├── session.signal          AbortSignal — aborts when session is dead beyond recovery
├── semaphore()             → Semaphore
│   ├── create()            → Promise<void>
│   ├── acquire()           → Lease          (AsyncDisposable)
│   ├── tryAcquire()        → Lease | null   (AsyncDisposable)
│   ├── update()
│   ├── delete()
│   ├── describe()
│   └── watch()             → AsyncIterable<SemaphoreDescription>
├── mutex()                 → Mutex           (recipe over Semaphore)
│   ├── lock()              → Lock            (AsyncDisposable)
│   └── tryLock()           → Lock | null     (AsyncDisposable)
└── election()              → Election        (recipe over Semaphore)
    ├── campaign()          → Leadership      (AsyncDisposable)
    │   ├── proclaim()
    │   ├── resign()
    │   └── signal
    ├── observe()           → AsyncIterable<LeaderState>
    └── leader()            → LeaderInfo | null
```

---

## DX guidance: choosing `createSession` vs `openSession`

Use `openSession()` by default for long-running workers and services. It is the primary interface and models session expiry as a normal lifecycle transition in a `for await` loop.

Use `createSession()` for one-shot flows and manual lifecycle control, where you explicitly handle a single session object and do not want automatic transition to a new lifecycle.

If `withSession()` is used as a helper, treat each callback invocation as one session scope. Objects created inside that callback must not be reused after callback completion or after session signal abort.

Quick rule:

- background worker / daemon / watcher → `openSession()`
- admin script / single command / setup action → `createSession()`
- callback-scoped workflow → `withSession()` (objects are valid only within callback session scope)

## Signal Chain

Session expiry is a normal event in a distributed system. The design uses a chain of `AbortSignal`s to propagate session death through all active operations automatically. No manual cleanup or event handlers needed.

```
session.signal                    — root signal, aborts when session is dead beyond recoveryWindow
  └── lease.signal                — derived, aborts when session.signal aborts
  └── lock.signal                 — derived, aborts when session.signal aborts
  └── leadership.signal           — derived, aborts when session.signal aborts
        └── your work signal      — your code uses leadership.signal to stop work
```

When a session dies beyond the recovery window:

1. `session.signal` aborts
2. All `observe()`, `watch()`, `campaign()` calls using `session.signal` terminate
3. All `Lease`/`Lock`/`Leadership` signals abort — in-progress work stops
4. The `for await` loop in `openSession()` catches the end and yields a new live session
5. Everything restarts cleanly from the next iteration

During a transient disconnect within `recoveryWindowMs`, the session reconnects transparently. `session.signal` does **not** abort. All signals remain valid. Work continues uninterrupted.

---

## Session lifecycle and recovery semantics (normative)

### Definition

A **coordination session** is a server-side entity in YDB Coordination Service, bound to a client bidirectional gRPC stream.

All runtime objects derived from that session are scoped to the same server session lifetime:

- `session.signal`
- acquired `Lease`/`Lock` handles
- active watch subscriptions
- any object that depends on session liveness

If the server session dies, all derived objects become invalid.

### Recovery window (`recoveryWindowMs`)

`recoveryWindowMs` is the SDK-level recovery window for restoring the same server session after transport loss.

On the wire, `recoveryWindowMs` is mapped to the protocol field `timeoutMillis` in `SessionStart`.

- If transport is restored **within** `recoveryWindowMs`, the client continues the **same** server session.
- If transport is not restored within `recoveryWindowMs`, the server session is dead and cannot be resumed.
- After that boundary, only a **new** session can be created.

### Behavior during transient disconnects

Transport disconnect/reconnect is normal in a distributed fault-tolerant system and is not treated as session death by itself.

While reconnecting within `recoveryWindowMs`, implementation **MUST** preserve:

- the same session identity
- non-aborted `session.signal`
- lease ownership semantics
- watch continuity semantics (including required re-subscription)

### Terminal session death

When server-side session death is confirmed (for example `SESSION_EXPIRED`, `BAD_SESSION`, or recovery window exceeded), implementation **MUST**:

- move session status to terminal (`expired`)
- abort `session.signal`
- abort all derived signals
- terminate all active watches/subscriptions
- stop retrying this session lifecycle

After terminal death, this session object must not become live again.

### Retry boundary

Retry is allowed only for transport recovery of a still-alive server session (inside `recoveryWindowMs`).

Retry is not allowed after confirmed server-side session death.

In short:

- reconnect inside recovery window → continue same session
- session expired on server → terminate this session lifecycle and create a new session object if needed

### No cross-lifecycle reuse (MUST)

Objects derived from a session lifecycle (handles and live runtime resources) are valid only while that lifecycle is live.

This includes, but is not limited to:

- `Semaphore`, `Mutex`, `Election` handles created from a session
- `Lease`, `Lock`, `Leadership` objects
- active iterators/subscriptions (`watch`, `observe`)
- derived abort signals (`lease.signal`, `lock.signal`, `leadership.signal`)

After `session.signal` is aborted, the caller MUST stop using all derived objects from that lifecycle and obtain fresh objects from a fresh session lifecycle.

For `openSession()`: each `for await` iteration is a new lifecycle boundary. Do not carry derived objects across iterations.

For `withSession()`: each callback invocation is a lifecycle boundary. Do not carry derived objects outside the callback or into a later callback invocation.

---

## Core Concepts

### Node

A coordination node is a server-side entity that hosts semaphores and sessions. Node management operations are unary gRPC calls (no streaming).

```typescript
interface CoordinationClient {
  createNode(path: string, config?: CoordinationNodeConfig, signal?: AbortSignal): Promise<void>
  alterNode(path: string, config?: CoordinationNodeConfig, signal?: AbortSignal): Promise<void>
  dropNode(path: string, signal?: AbortSignal): Promise<void>
  describeNode(path: string, signal?: AbortSignal): Promise<CoordinationNodeDescription>

  // Single-lifecycle API (manual control):
  // - reconnects while server session is alive (within recoveryWindowMs)
  // - becomes terminal when server session expires
  // - does not auto-create a replacement lifecycle
  createSession(
    path: string,
    options?: SessionOptions,
    signal?: AbortSignal
  ): Promise<CoordinationSession>

  // Primary API for production workloads:
  // - each iteration yields one live CoordinationSession lifecycle
  // - after terminal expiry, yields the next lifecycle
  // - stop with break/return or external AbortSignal
  openSession(
    path: string,
    options?: SessionOptions,
    signal?: AbortSignal
  ): AsyncIterable<CoordinationSession>

  // Callback helper over createSession():
  // - creates one session lifecycle
  // - invokes callback once
  // - always closes session in finally
  // - never retries/re-runs callback automatically
  withSession<T>(
    path: string,
    callback: (session: CoordinationSession) => Promise<T>,
    options?: SessionOptions,
    signal?: AbortSignal
  ): Promise<T>
}
```

### Session

A session is a bidirectional gRPC stream to a coordination node. All semaphore operations happen within a session.

In `createSession()` mode, the returned object represents a single server-session lifecycle:

- reconnects and retries transport while still inside `recoveryWindowMs`
- preserves the same session identity within that recovery window
- transitions to terminal `expired` state when server session death is confirmed
- never auto-restarts itself after terminal expiry

In `openSession()` mode, each yielded object has the same single-lifecycle semantics, and the iterator is responsible for yielding the next lifecycle.

In `withSession()` mode, callback execution is scoped to one session lifecycle. If `session.signal` is aborted, the callback must stop using derived objects and continue only with fresh objects from a fresh session lifecycle (in the next `openSession()` iteration or in a new `withSession()` call).

```typescript
interface CoordinationSession extends AsyncDisposable {
  readonly sessionId: bigint
  readonly isClosed: boolean

  // Lifecycle status of this session object.
  // `expired` means server-side session is dead and this object will not become live again.
  readonly status: 'connecting' | 'ready' | 'closing' | 'closed' | 'expired'

  // Aborts when the session is confirmed dead beyond recoveryWindow
  // or when it is explicitly closed. All derived signals abort as well.
  readonly signal: AbortSignal

  semaphore(name: string, options?: SemaphoreOptions): Semaphore
  mutex(name: string): Mutex
  election(name: string): Election

  close(signal?: AbortSignal): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
```

### Semaphore

A semaphore is a server-side object with a `limit` (total tokens) that sessions can acquire `count` tokens from. `session.semaphore()` returns a local handle — no network call until an operation is invoked.

```typescript
interface SemaphoreOptions {
  limit?: number // total tokens; required when semaphore must be created
  data?: Uint8Array // user-defined data attached to the semaphore itself
}

interface CreateSemaphoreOptions {
  limit: number // total tokens for this semaphore
  data?: Uint8Array // user-defined data attached to the semaphore itself
}

interface AcquireOptions {
  count?: number // tokens to acquire (default: 1)
  timeoutMillis?: number // how long to wait in queue (default: Infinity)
  data?: Uint8Array // user-defined data attached to this owner entry
  ephemeral?: boolean // auto-delete semaphore when last owner releases
}

interface Semaphore {
  readonly name: string

  // Explicitly creates a semaphore on the server
  create(options: CreateSemaphoreOptions, signal?: AbortSignal): Promise<void>

  // Blocks until acquired or signal aborts
  acquire(options?: AcquireOptions, signal?: AbortSignal): Promise<Lease>
  // Returns null immediately if not acquired (default) or within timeoutMillis
  tryAcquire(options?: AcquireOptions, signal?: AbortSignal): Promise<Lease | null>

  // Updates user-defined data attached to the semaphore
  update(data: Uint8Array, signal?: AbortSignal): Promise<void>
  // Deletes the semaphore. Fails if acquired unless force: true
  delete(options?: DeleteOptions, signal?: AbortSignal): Promise<void>
  // Returns current semaphore state
  describe(options?: DescribeOptions, signal?: AbortSignal): Promise<SemaphoreDescription>
  // Yields on every change. Terminates when signal aborts.
  watch(options?: WatchOptions, signal?: AbortSignal): AsyncIterable<SemaphoreDescription>
}

### Watch subscription semantics

`watch()` uses `DescribeSemaphore` with `WatchData` / `WatchOwners` flags. The server responds with a `DescribeSemaphoreChanged` message when something changes.

**`DescribeSemaphoreChanged` has two forms:**

- `dataChanged: true` or `ownersChanged: true` — the semaphore actually changed, the new state is meaningful
- `dataChanged: false, ownersChanged: false` — the subscription was interrupted; the server is not sure whether a notification was lost

The second form (both fields `false`) is a signal to re-subscribe, not a notification of a real change. It fires at the slightest suspicion that a notification may have been lost:
- A new `DescribeSemaphore` call replaced the previous subscription for the same semaphore in this session
- Temporary connection loss between the gRPC client and server
- Temporary connection loss between the gRPC server and the coordination service leader
- Coordination service leader change

**One active subscription per semaphore per session.** A new `DescribeSemaphore` call with watch flags cancels the previous subscription, sending `DescribeSemaphoreChanged { dataChanged: false, ownersChanged: false }` for it. If `watch()` is called twice for the same semaphore in the same session, the first iterator terminates early.

**After receiving `dataChanged: false, ownersChanged: false` the client must re-issue `DescribeSemaphore`.** The new result may differ from the previous — the notification may have been genuinely lost.

**The SDK's `watch()` handles this automatically.** On any `DescribeSemaphoreChanged { dataChanged: false, ownersChanged: false }` it re-issues `DescribeSemaphore` and resumes the subscription transparently — the `for await` loop continues without interruption. Only confirmed session expiry (`session.signal` aborted) terminates the iterator.

A `reqId` is tracked internally to discard stale `DescribeSemaphoreChanged` messages from a replaced subscription (as recommended by the YDB documentation).

### gRPC stream processing architecture

The bidirectional session stream carries three fundamentally different message types:

**1. Request-response (`*Result` messages)**

Messages: `acquireSemaphoreResult`, `releaseSemaphoreResult`, `createSemaphoreResult`, `updateSemaphoreResult`, `deleteSemaphoreResult`, `describeSemaphoreResult`

Each contains a `reqId` that matches it to a pending request. The SDK maintains `Map<reqId, PendingRequest>` — when a result arrives, the corresponding promise is resolved or rejected. This is handled transparently by `BidirectionalStream`.

**2. Session lifecycle**

Messages: `ping`, `failure`, `sessionStarted`, `sessionStopped`

These are handled directly in `#handleResponse`:
- `ping` → auto-respond with `pong`
- `failure` with `SESSION_EXPIRED` / `BAD_SESSION` → abort all leases, reset session ID, trigger reconnection
- `sessionStarted` → resolve pending promises, session is ready
- `sessionStopped` → confirm graceful close

**3. Push notifications (out-of-band)**

Messages: `acquireSemaphorePending`, `describeSemaphoreChanged`

These arrive without a matching pending request — they are server-initiated notifications:

- `acquireSemaphorePending` → "your acquire is queued, waiting for tokens". Final result comes later as `acquireSemaphoreResult`. Currently logged but not exposed to user API.

- `describeSemaphoreChanged` → semaphore state may have changed. Contains `reqId` of the `DescribeSemaphore` that established the subscription, plus `dataChanged` and `ownersChanged` booleans.

**Processing `describeSemaphoreChanged`:**

```

describeSemaphoreChanged arrives
│
├─ Look up semaphore name by reqId
│ └─ If not found → stale notification from replaced subscription, ignore
│
├─ Both dataChanged=false, ownersChanged=false
│ └─ "subscription interrupted" → wake up watch() → re-subscribe → compare snapshots
│ └─ If snapshot changed → yield new description
│ └─ If snapshot unchanged → silently continue (no yield)
│
└─ Either dataChanged=true OR ownersChanged=true
└─ "real change detected" → wake up watch() → re-subscribe → yield new description

```

**Why both forms wake up `watch()`:**

The `{ dataChanged: false, ownersChanged: false }` form means "I'm not sure if you missed a notification". The SDK must re-subscribe to find out. After re-subscription:
- If the new snapshot differs from the previous → a real change occurred, yield it
- If the snapshot is identical → the interruption was spurious, continue waiting

This ensures no changes are missed while avoiding duplicate yields.

**ReqId tracking for subscriptions:**

The SDK tracks `Map<semaphoreName, currentReqId>` (not just `reqId → name`). This allows:
1. Discarding stale `describeSemaphoreChanged` from a replaced subscription
2. Knowing which subscription is current when multiple `watch()` calls exist

The tracking is updated atomically during each `describe()` call inside the `watch()` loop.

### Acquire semantics — idempotency and count reduction

Per [YDB Coordination documentation](https://ydb.tech/docs/en/reference/ydb-sdk/coordination):

> `AcquireSemaphore` is idempotent. Repeated calls for the same semaphore within the same session **replace** the previous acquire operation. The previous operation completes with `ABORTED` if it was still pending. The position in the queue is preserved.

**Count can only be decreased, never increased:**

```

acquire({ count: 10 }) → lease, held with count=10
acquire({ count: 5 }) → server replaces acquire, count reduced to 5 ✓
acquire({ count: 15 }) → BAD_REQUEST: "Increasing count is not allowed" ✗

````

When `count` is increased the server returns `BAD_REQUEST` immediately. The existing lease is **not affected** — it remains valid with the original count. No supersession occurs.

**Primary use case — downgrade from exclusive to shared lock:**

This is the canonical pattern from YDB documentation. A worker first acquires all tokens (exclusive access for setup), then reduces count to allow others in:

```typescript
// Phase 1: exclusive access — take all 5 tokens so nobody else can enter
await using lease1 = await semaphore.acquire({ count: 5 })
// ... critical setup, e.g. schema migration ...

// Phase 2: downgrade to shared — only 1 token needed, 4 freed for others
await using lease2 = await semaphore.acquire({ count: 1 })
// lease1.signal aborted with 'superseded' — work under lease1 should stop
// lease2.signal is now live, semaphore held with count=1

// LIFO disposal with await using:
// 1. lease2[asyncDispose] → release() → semaphore released ✓
// 2. lease1[asyncDispose] → signal already aborted → no-op ✓
````

**What happens to the old `Lease` when a new `acquire` is called:**

- The server sends `ABORTED` for the old `req_id` if it was still pending (waiting in queue)
- If already acquired, the server silently replaces the count
- The SDK tracks the active lease per semaphore name in the session via `Map<semaphoreName, AbortController>`
- Multiple local handles with the same semaphore name in one session point to the same server-side semaphore state (`sessionId + semaphoreName`)
- When a new `acquire` supersedes the old one, the old `lease.signal` aborts with reason `'superseded'`
- The old `lease[asyncDispose]` becomes a no-op — the new lease owns the release lifecycle
- If the new `acquire` fails (e.g. `BAD_REQUEST` for count increase) — the old lease is **not touched**, supersession does not occur

```typescript
await using lease1 = await semaphore.acquire({ count: 10 })
// lease1.signal is live, semaphore held with count=10

await using lease2 = await semaphore.acquire({ count: 5 })
// lease1.signal.aborted === true  (reason: 'superseded')
// lease2.signal is live, semaphore held with count=5

// LIFO disposal order with await using:
// 1. lease2[asyncDispose] → release() → semaphore released
// 2. lease1[asyncDispose] → signal already aborted → no-op ✓

// Failed upgrade — old lease survives:
try {
  await semaphore.acquire({ count: 15 }) // BAD_REQUEST
} catch {
  // lease2 is still valid, not superseded
}
```

**Why `lease.signal` and not an error?**

Aborting `lease1.signal` rather than throwing an error means any in-progress work using `lease1.signal` gracefully stops — the same mechanism as session expiry. The caller doesn't need separate error handling for "superseded" vs "session expired"; both flow through `signal`.

**`release()` and `acquire()` are not reentrant:**

> Regardless of how many `AcquireSemaphore` calls were made for a given semaphore in one session, a single `ReleaseSemaphore` releases it entirely. `AcquireSemaphore` / `ReleaseSemaphore` cannot be used as an analogue of acquire/release on a recursive mutex.

This means the session internally tracks **one active lease per semaphore name**. Calling `release()` on a superseded lease is always a no-op and **must not** release the currently active replacement lease for that semaphore name.

**`release()` also cancels a pending (queued) acquire:**

> A queued `AcquireSemaphore` operation can be prematurely terminated by calling `ReleaseSemaphore`.

If `acquire()` is waiting in the queue (semaphore fully held by others) and the caller decides to give up, calling `release()` on the pending lease sends `ReleaseSemaphore` to the server, which removes it from the queue. This is the correct way to implement "wait up to N ms, then skip" without relying solely on `timeoutMillis`.

**`acquire()` and `release()` return `bool`:**

Both `AcquireSemaphore` and `ReleaseSemaphore` return a boolean indicating whether the semaphore state was actually altered:

- `acquire()` → `false` means the semaphore was not acquired within `timeoutMillis` (others hold it). The SDK surfaces this as `null` from `tryAcquire()` or throws `TIMEOUT` from `acquire()`.
- `release()` → `false` means the semaphore was not held by this session (already released, or never acquired). The SDK treats this as a no-op in superseded-lease paths.

### Lease

Result of a successful `semaphore.acquire()`. Represents held tokens. `lease.signal` is derived from `session.signal` — aborts automatically when the session dies or when superseded by a new `acquire`.

```typescript
interface Lease extends AsyncDisposable {
  readonly name: string
  // Aborts when:
  // - session expires (reason: 'session expired')
  // - superseded by a new acquire on the same semaphore (reason: 'superseded')
  readonly signal: AbortSignal

  release(signal?: AbortSignal): Promise<void>
  [Symbol.asyncDispose](): Promise<void> // → release(), no-op if superseded
}
```

### Mutex

A high-level recipe over `Semaphore`. Creates an ephemeral semaphore with `limit = MAX_UINT64` and acquires `count = MAX_UINT64` — exclusive ownership, because no other session can acquire any tokens while all are held.

`Lock` is semantically identical to `Lease` but named to signal exclusive intent.

```typescript
interface Mutex {
  readonly name: string

  lock(signal?: AbortSignal): Promise<Lock> // blocks until locked
  tryLock(signal?: AbortSignal): Promise<Lock | null> // null if already held
}

interface Lock extends AsyncDisposable {
  readonly name: string
  readonly signal: AbortSignal // derived from session.signal

  release(signal?: AbortSignal): Promise<void>
  [Symbol.asyncDispose](): Promise<void> // → release()
}
```

**Why `MAX_UINT64` for both `limit` and `count`?**

YDB Coordination Service hardcodes `limit = MAX_UINT64` for ephemeral semaphores. Mutual exclusion is achieved by the acquirer taking all tokens (`count = MAX_UINT64`). No other session can acquire even a single token while all are held. When released, the ephemeral semaphore is deleted automatically.

### Election

A high-level recipe over `Semaphore` with `limit = 1`, `ephemeral = false`. Only one session can hold the single token — that session is the leader. Others queue up and become leader in order when the current leader resigns or its session expires.

```typescript
interface Election {
  readonly name: string

  // Participates in election. Blocks until this session becomes the leader.
  campaign(data: Uint8Array, signal?: AbortSignal): Promise<Leadership>

  // AsyncIterable that yields on every leader change.
  // Works independently from campaign() — usable without participating.
  // Terminates when signal aborts.
  observe(signal?: AbortSignal): AsyncIterable<LeaderState>

  // One-shot query for the current leader. Returns null if no leader.
  leader(signal?: AbortSignal): Promise<LeaderInfo | null>
}

interface Leadership extends AsyncDisposable {
  // Derived from session.signal — aborts when leadership is lost involuntarily
  readonly signal: AbortSignal

  // Updates leader's public data without re-election (semaphore.update under the hood)
  proclaim(data: Uint8Array, signal?: AbortSignal): Promise<void>
  // Voluntarily gives up leadership
  resign(signal?: AbortSignal): Promise<void>
  [Symbol.asyncDispose](): Promise<void> // → resign()
}

interface LeaderState {
  // Data published by the current leader via campaign(data) or proclaim(data)
  data: Uint8Array
  // True if the current leader is this session
  isMe: boolean
  // Aborts when the leader changes
  signal: AbortSignal
}

interface LeaderInfo {
  data: Uint8Array
}
```

---

## Use Case Scenarios

### Scenario 1 — Single active worker (participant only)

Multiple workers compete to be the sole processor of a task queue. Only the leader processes tasks. If the leader's session expires, another worker takes over. Network blips within `recoveryWindowMs` are transparent — leadership is preserved.

```typescript
import { coordination } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let driver = new Driver('grpc://localhost:2136/local')
let client = coordination(driver)

await client.createNode('/local/workers')

async function runWorker(endpoint: string) {
  // openSession() automatically reconnects when a session dies beyond recoveryWindow.
  // Each iteration gets a fresh, live session.
  for await (let session of client.openSession('/local/workers', { recoveryWindowMs: 30_000 })) {
    let election = session.election('task-processor-leader')

    try {
      // Blocks until we become the leader.
      // Passes session.signal so that if the session dies mid-wait, campaign is cancelled
      // and session loop moves to the next iteration (new session, try again).
      await using leadership = await election.campaign(
        new TextEncoder().encode(endpoint),
        session.signal
      )

      console.log('I am the leader, starting task processing')

      // leadership.signal is derived from session.signal.
      // Transient disconnect within recoveryWindow → session recovers → signal stays valid.
      // Session fully expired → session.signal aborts → leadership.signal aborts → work stops.
      await processTaskQueue({ signal: leadership.signal })
    } catch (error) {
      if (session.signal.aborted) {
        // Session died — outer loop will give us a new session and we try again
        console.log('Session expired, reconnecting...')
        continue
      }
      throw error
    }
    // leadership[asyncDispose] → resign(), next candidate in queue becomes leader
  }
}
```

---

### Scenario 2 — Observe leader without participating

A client does not compete for leadership but always needs to know who the current leader is (e.g., to route requests). Reconnects transparently on session failure.

```typescript
async function observeLeader(signal: AbortSignal) {
  for await (let session of client.openSession('/local/workers', {}, signal)) {
    let election = session.election('task-processor-leader')

    try {
      // observe uses session.signal — when session dies, the loop exits
      // and the outer openSession() loop gives us a new session automatically
      for await (let state of election.observe(session.signal)) {
        let endpoint = new TextDecoder().decode(state.data)
        console.log('Current leader:', endpoint)
        routeRequestsTo(endpoint)
      }
    } catch (error) {
      if (session.signal.aborted) {
        console.log('Session expired, reconnecting observer...')
        continue
      }
      throw error
    }
  }
}

// One-shot query when you just need the current leader once
async function getCurrentLeader(): Promise<string | null> {
  await using session = await client.createSession('/local/workers')
  let election = session.election('task-processor-leader')
  let leader = await election.leader()
  return leader ? new TextDecoder().decode(leader.data) : null
}
```

---

### Scenario 3 — Participant + observer in one session

A worker both competes for leadership and observes the current leader. While not the leader, it routes requests to the current leader. When it wins, it processes work. When it loses leadership (voluntary or involuntary), it goes back to observing and eventually wins the next election.

The key: `campaign` and `observe` run concurrently on the same session. Both use `session.signal` — when the session dies, both are cancelled and the outer `openSession()` loop restarts everything cleanly.

```typescript
async function runWorker(endpoint: string, signal: AbortSignal) {
  for await (let session of client.openSession('/local/workers', {}, signal)) {
    let election = session.election('task-processor-leader')

    // Combine session.signal with external signal to stop on either
    let combined = AbortSignal.any([session.signal, signal])

    try {
      // campaign runs in background — blocks until we win
      // When session.signal aborts, campaign is cancelled immediately
      let campaignPromise = election.campaign(new TextEncoder().encode(endpoint), combined)

      // observe runs in foreground — yields on every leader change
      // When session.signal aborts, observe terminates
      for await (let state of election.observe(combined)) {
        if (state.isMe) {
          // campaign resolved at this exact moment — we are the leader
          let leadership = await campaignPromise

          try {
            // leadership.signal is derived from session.signal
            // If session dies: leadership.signal aborts → work stops → session loop restarts
            await processWork({ signal: leadership.signal })
          } finally {
            // Whether we lost leadership voluntarily or not, re-enter the race
            // state.signal aborts when a new leader is elected (isMe becomes false)
            campaignPromise = election.campaign(new TextEncoder().encode(endpoint), combined)
          }
        } else {
          // Not the leader — route to whoever is
          let leaderEndpoint = new TextDecoder().decode(state.data)
          routeRequestsTo(leaderEndpoint)
        }
      }
    } catch (error) {
      if (session.signal.aborted) {
        console.log('Session expired, reconnecting...')
        continue
      }
      throw error
    }
  }
}
```

---

### Scenario 4 — Per-task distributed mutex

Each task in a queue must be processed by exactly one worker. Workers race to lock each task. Whoever wins processes it; others skip. Semaphore is ephemeral — deleted automatically when released.

```typescript
async function runWorker(tasks: string[]) {
  for await (let session of client.openSession('/local/task-locks')) {
    try {
      for (let taskId of tasks) {
        let mutex = session.mutex(`task:${taskId}`)

        // Non-blocking: returns null immediately if another worker holds the lock
        let lock = await mutex.tryLock(session.signal)
        if (!lock) {
          console.log(`Task ${taskId} is already being processed, skipping`)
          continue
        }

        await using _ = lock

        try {
          // lock.signal is derived from session.signal
          // If session dies mid-task, lock.signal aborts and task is abandoned
          // Another worker will pick it up after the ephemeral semaphore is released
          await processTask(taskId, { signal: lock.signal })
        } catch (error) {
          if (lock.signal.aborted) {
            console.log(`Lost lock for task ${taskId} due to session expiry`)
            // Outer openSession() loop will give us a new session — we will retry
            break
          }
          throw error
        }
        // lock[asyncDispose] → release, ephemeral semaphore deleted automatically
      }
    } catch (error) {
      if (session.signal.aborted) {
        continue
      }
      throw error
    }
  }
}
```

---

### Scenario 5 — Service Discovery

Workers register their endpoints on startup. Clients subscribe to the live list of available workers and update their load balancer on every change. When a worker crashes or its session expires, its endpoint disappears from the list automatically.

```typescript
// Worker: register presence
async function registerWorker(endpoint: string, signal: AbortSignal) {
  // Each session iteration = one registration lifetime.
  // If the session dies and reconnects within recoveryWindow, registration is preserved.
  // If the session fully expires, the lease is released and the worker disappears.
  // The next iteration re-registers automatically.
  for await (let session of client.openSession(
    '/local/api-service',
    { recoveryWindowMs: 15_000 },
    signal
  )) {
    let semaphore = session.semaphore('endpoints')

    try {
      // Each worker acquires 1 token and attaches its endpoint as data.
      // ephemeral: server uses MAX_UINT64 as limit automatically.
      await using lease = await semaphore.acquire(
        {
          count: 1,
          data: new TextEncoder().encode(endpoint),
          ephemeral: true,
        },
        session.signal
      )

      console.log(`Registered ${endpoint}`)

      // Hold the lease until the session dies or external signal aborts
      await new Promise<void>((_, reject) => {
        lease.signal.addEventListener('abort', () => reject(lease.signal.reason), { once: true })
      })
    } catch (error) {
      if (session.signal.aborted) {
        console.log('Session expired, re-registering...')
        continue
      }
      throw error
    }
    // lease[asyncDispose] → release, endpoint removed from the list
  }
}

// Client: subscribe to the live endpoint list
async function watchEndpoints(signal: AbortSignal) {
  for await (let session of client.openSession('/local/api-service', {}, signal)) {
    let semaphore = session.semaphore('endpoints')

    try {
      for await (let desc of semaphore.watch({ owners: true }, session.signal)) {
        let endpoints = desc.owners?.map((o) => new TextDecoder().decode(o.data)) ?? []
        console.log('Available workers:', endpoints)
        updateLoadBalancer(endpoints)
      }
    } catch (error) {
      if (session.signal.aborted) {
        continue
      }
      throw error
    }
  }
}
```

---

### Scenario 6 — Shared configuration

A configuration service publishes config updates. All workers subscribe and apply the latest config in real time. Workers automatically recover the latest config after a session restart.

```typescript
// Publisher: push config update
async function publishConfig(config: AppConfig) {
  // Single session is fine here — this is a one-shot operation
  await using session = await client.createSession('/local/app-config')
  let semaphore = session.semaphore('config')
  await semaphore.update(new TextEncoder().encode(JSON.stringify(config)))
  console.log('Config published:', config)
}

// Worker: subscribe to config changes
async function watchConfig(signal: AbortSignal) {
  for await (let session of client.openSession('/local/app-config', {}, signal)) {
    let semaphore = session.semaphore('config')

    try {
      // watch yields immediately with the current value, then on every change.
      // When session restarts, we immediately get the latest config again —
      // no stale state, no missed updates.
      for await (let desc of semaphore.watch({ data: true }, session.signal)) {
        if (desc.data?.length) {
          let config = JSON.parse(new TextDecoder().decode(desc.data)) as AppConfig
          console.log('Applying config:', config)
          applyConfig(config)
        }
      }
    } catch (error) {
      if (session.signal.aborted) {
        console.log('Session expired, reconnecting config watcher...')
        continue
      }
      throw error
    }
  }
}
```

---

### Scenario 7 — Leader publishes its endpoint via proclaim

The leader's endpoint is not known at `campaign` time (e.g., dynamic port assignment after the HTTP server starts). `proclaim` updates the leader's public data without re-election. All observers see the updated endpoint immediately.

```typescript
async function runWorker(signal: AbortSignal) {
  for await (let session of client.openSession('/local/workers', {}, signal)) {
    let election = session.election('api-leader')

    try {
      // Campaign with placeholder — real endpoint unknown yet
      await using leadership = await election.campaign(
        new TextEncoder().encode('starting'),
        session.signal
      )

      // Start the server and get the actual port
      let server = await startHttpServer()
      let endpoint = `${hostname()}:${server.port}`

      // Update leader data — all observers see the new endpoint immediately
      // No re-election, no token release
      await leadership.proclaim(new TextEncoder().encode(endpoint), session.signal)
      console.log(`Leader, serving at ${endpoint}`)

      // Serve until leadership is lost
      await server.serve({ signal: leadership.signal })
    } catch (error) {
      if (session.signal.aborted) {
        console.log('Session expired, re-entering election...')
        continue
      }
      throw error
    }
    // leadership[asyncDispose] → resign(), next candidate becomes leader
  }
}

// Followers: observe and route, skip 'starting' placeholder
async function runFollower(signal: AbortSignal) {
  for await (let session of client.openSession('/local/workers', {}, signal)) {
    let election = session.election('api-leader')

    try {
      for await (let state of election.observe(session.signal)) {
        let endpoint = new TextDecoder().decode(state.data)
        if (endpoint !== 'starting') {
          routeRequestsTo(endpoint)
        }
      }
    } catch (error) {
      if (session.signal.aborted) {
        continue
      }
      throw error
    }
  }
}
```

---

## Design Decisions

### `AcquireSemaphore` idempotency and the session lease registry

The server tracks **one active acquire per (session, semaphore name)** pair. This has two important implications:

1. **Repeated `acquire()` calls replace, not stack** — the SDK must mirror this by keeping a `Map<semaphoreName, AbortController>` of active leases. When a new `acquire` comes in for a name already in the map, the old `AbortController` is aborted with reason `'superseded'` before the new request is sent.

2. **One `release()` releases everything** — `ReleaseSemaphore` always fully releases the semaphore for this session, regardless of how many `acquire()` calls were made. The SDK enforces this by making `release()` on a superseded lease a no-op.

The `ABORTED` status code from the server (for a still-pending acquire that was superseded) is handled internally — it aborts the old lease signal rather than propagating as a thrown error.

### `openSession()` — AsyncIterable as reconnect primitive

Session expiry is a normal event in a distributed system, not an exception. `openSession()` models this explicitly: each iteration of the loop is a live, ready session. When a session dies beyond `recoveryWindowMs`, the loop automatically yields the next session. The caller's code is just a regular `for await` — no event handlers, no manual retry logic, no state machines.

`createSession()` still exists for cases where you want manual control (admin scripts, one-shot operations, tests).

### `session.signal` as the root of the signal chain

Instead of events (`session.on('sessionExpired', ...)`), the session exposes a standard `AbortSignal`. This composes naturally with everything else in the codebase — `AbortSignal.any()`, `AbortSignal.timeout()`, and all operations that already accept `signal`. When the session dies, one signal abort cascades through the entire call tree.

### Transient disconnect vs. session expiry

There are two distinct failure modes:

|                  | Transient disconnect        | Session expiry                   |
| ---------------- | --------------------------- | -------------------------------- |
| Duration         | Within `recoveryWindowMs`   | Beyond `recoveryWindowMs`        |
| `session.signal` | Does **not** abort          | Aborts                           |
| Semaphore state  | Preserved on server         | Released by server               |
| Caller impact    | Transparent, work continues | All derived signals abort        |
| Recovery         | Automatic reconnect         | New iteration in `openSession()` |

This distinction is critical for correctness: a brief network blip should not cause leadership re-election or semaphore re-acquisition.

### Why semaphore operations are session-scoped, but node creation stays on client

`session.semaphore()` returns a local, lifecycle-bound handle — no network call until an operation is invoked. This keeps semaphore work consistent with the session ownership model (signals, leases, watches, and retries are scoped to one live session lifecycle).

`semaphore.create()` explicitly creates a semaphore on the server for that session context. `ephemeral: true` on `acquire()` still supports implicit creation on first acquire and auto-deletion on last release.

Node operations (`createNode`, `alterNode`, `dropNode`, `describeNode`) remain on `CoordinationClient` by design: a node is infrastructure-level state, not a session-owned runtime object. Node management must be available independently from any particular session lifecycle.

### Why `Mutex` uses `ephemeral = true` with `count = MAX_UINT64`

YDB Coordination Service hardcodes `limit = MAX_UINT64` for ephemeral semaphores. Mutual exclusion is achieved by the acquirer taking all tokens. No other session can acquire even a single token while all are held. When the mutex is released, the ephemeral semaphore is deleted automatically — no cleanup needed.

### Why `Election` uses `limit = 1` with a non-ephemeral semaphore

With `limit = 1`, only one session can hold the token at any time — natural leader election. Non-ephemeral so that `observe()` can watch it even when no candidate currently holds it (gap between leaders).

### Why `campaign` blocks until leader

This is the standard semantics across all distributed systems SDKs (etcd Go/JS/Rust, ZooKeeper Curator, Consul). The blocking call with `await using` gives a clear lifecycle: you have leadership from the line after `campaign` until `resign()` or session expiry. No callbacks, no state machines.

### Why `campaign` and `observe` are independent

These serve different purposes and different audiences:

- `campaign` — gives you a `Leadership` handle with `resign()`, `proclaim()`, and `signal`. For participants only.
- `observe` — gives a unified event stream for anyone: participants and non-participants alike.

Running both on the same session (Scenario 3) is the recommended pattern for workers that both compete and observe. They share the same underlying session and semaphore but operate independently. `isMe` in `LeaderState` lets you distinguish "I won" from "someone else won" in the observer stream.

### `isMe` in `LeaderState`

Without `isMe`, an observer cannot reliably determine if the current leader is itself — it would need to compare `state.data` against its own published data, which requires data to be unique and globally known. `isMe` compares `owner.sessionId === session.sessionId` internally, which is always unambiguous.

### `Lease` vs `Lock` naming

Both are `AsyncDisposable` handles representing acquired tokens, but names signal intent:

- `Lease` — result of `semaphore.acquire()`, general-purpose token ownership
- `Lock` — result of `mutex.lock()`, signals exclusive ownership intent

### Session FSM canonical naming and types

The coordination session FSM lives in `src/runtime/session-state.ts`. The
types below are the normative source of truth — they match the implementation
exactly and should be kept in sync with it.

#### Session states (`SessionState`)

```typescript
type SessionState =
  | 'idle' // Initial state before session.start is dispatched
  | 'connecting' // Stream open, waiting for session.stream.response.started
  | 'ready' // Session established and usable
  | 'reconnecting' // Transport lost; waiting for retry backoff to open a new stream
  | 'closing' // Graceful close initiated; waiting for session.stream.response.stopped
  | 'expired' // Terminal: server-side session death or recovery window exceeded
  | 'closed' // Terminal: clean close or forced destroy
```

#### Session events (`SessionEvent`)

```typescript
// Lifecycle control — dispatched by callers or by the outer-signal abort listener.
type SessionEvent =
  | { type: 'session.start' }
  | { type: 'session.close' }
  | { type: 'session.abort'; reason?: unknown }
  | { type: 'session.destroy'; reason?: unknown }

  // Transport lifecycle — dispatched by the stream open/close effects.
  | { type: 'session.stream.connected' }
  | { type: 'session.stream.disconnected'; reason?: unknown }

  // Protocol responses — routed from the ingest loop.
  | { type: 'session.stream.response.ping'; opaque: bigint }
  | { type: 'session.stream.response.started'; sessionId: bigint }
  | { type: 'session.stream.response.stopped'; sessionId?: bigint }
  | { type: 'session.stream.response.failure'; status: StatusIds_StatusCode; issues?: unknown[] }

  // Timer expiries — dispatched by setTimeout callbacks.
  | { type: 'session.timer.start_timeout' }
  | { type: 'session.timer.retry_backoff_elapsed' }
  | { type: 'session.timer.recovery_window_expired' }

  // Internal errors — dispatched when a non-abort stream error occurs.
  | { type: 'session.internal.fatal'; error: unknown }
```

#### Session effects (`SessionEffect`)

Effects represent side-effectful work the runtime must perform after each
transition. The transition function is pure — it only returns effects; the
runtime executes them.

```typescript
type SessionEffect =
  // Stream lifecycle
  | { type: 'session.effect.stream.open' }
  | { type: 'session.effect.stream.close' }
  | { type: 'session.effect.stream.send_stop' }
  | { type: 'session.effect.stream.send_pong'; opaque: bigint }

  // Timer control
  | { type: 'session.effect.timer.schedule_start_timeout' }
  | { type: 'session.effect.timer.schedule_retry_backoff' }
  | { type: 'session.effect.timer.schedule_recovery_window' }
  | { type: 'session.effect.timer.clear_start_timeout' }
  | { type: 'session.effect.timer.clear_retry_backoff' }
  | { type: 'session.effect.timer.clear_recovery_window' }

  // Runtime lifecycle markers
  | { type: 'session.effect.runtime.emit_error'; error: unknown }
  | { type: 'session.effect.runtime.mark_ready'; sessionId: bigint }
  | { type: 'session.effect.runtime.mark_closed'; reason: unknown }
  | { type: 'session.effect.runtime.mark_expired'; reason: unknown }
  | { type: 'session.effect.runtime.restore_after_reconnect' }
```

#### Session output (`SessionOutput`)

```typescript
type SessionOutput =
  | { type: 'session.error'; error: unknown }
  | { type: 'session.ready'; sessionId: bigint }
  | { type: 'session.closed'; reason?: unknown }
  | { type: 'session.expired'; sessionId?: bigint; reason?: unknown }
```

#### Naming rules (normative)

- `session.start` is dispatched internally on runtime creation — callers do not dispatch it
- `session.close` initiates a graceful stop (sends `SessionStop` on the wire)
- `session.abort` is treated identically to `session.close` in the FSM (both move to `closing`)
- `session.destroy` is an immediate forced close — bypasses the graceful stop sequence and goes directly to `closed`
- Outer abort signals are wired to `session.destroy`, not `session.close`
- `session.stream.request.*` prefixed events do not exist in the FSM — stream sends are side effects, not events
- `session.stream.disconnected` is dispatched by the stream source generator's `finally` block when the gRPC stream ends

### Session FSM transition table (normative)

| Current state      | Event                                                             | Next state     | Required effects                                                                       |
| ------------------ | ----------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `idle`             | `session.start`                                                   | `connecting`   | open stream; schedule start timeout                                                    |
| `idle`             | `session.close` / `session.abort`                                 | `closed`       | mark_closed immediately (never connected)                                              |
| `connecting`       | `session.stream.response.started`                                 | `ready`        | store `sessionId`; mark_ready; clear timers; emit restore_after_reconnect if reconnect |
| `connecting`       | `session.stream.response.ping`                                    | (unchanged)    | send_pong                                                                              |
| `connecting`       | `session.timer.start_timeout` / `session.stream.disconnected`     | `reconnecting` | clear start timeout; schedule retry backoff + recovery window                          |
| `connecting`       | `session.close` / `session.abort`                                 | `closing`      | send_stop; clear all timers                                                            |
| `connecting`       | `session.stream.response.failure` (terminal status)               | `expired`      | clear timers; mark_expired                                                             |
| `ready`            | `session.stream.response.ping`                                    | (unchanged)    | send_pong                                                                              |
| `ready`            | `session.stream.disconnected`                                     | `reconnecting` | schedule retry backoff + recovery window                                               |
| `ready`            | `session.stream.response.failure` (terminal status)               | `expired`      | clear timers; mark_expired                                                             |
| `ready`            | `session.close` / `session.abort`                                 | `closing`      | send_stop; clear all timers                                                            |
| `reconnecting`     | `session.stream.response.started`                                 | `ready`        | store `sessionId`; mark_ready; clear timers; emit restore_after_reconnect              |
| `reconnecting`     | `session.stream.response.ping`                                    | (unchanged)    | send_pong                                                                              |
| `reconnecting`     | `session.timer.retry_backoff_elapsed`                             | `connecting`   | open stream; schedule start timeout                                                    |
| `reconnecting`     | `session.timer.recovery_window_expired`                           | `expired`      | clear timers; mark_expired                                                             |
| `reconnecting`     | `session.stream.response.failure` (terminal status)               | `expired`      | clear timers; mark_expired                                                             |
| `reconnecting`     | `session.close` / `session.abort`                                 | `closing`      | send_stop; clear all timers                                                            |
| `closing`          | `session.stream.response.stopped` / `session.stream.disconnected` | `closed`       | close stream; clear timers; mark_closed                                                |
| `closing`          | `session.stream.response.ping`                                    | (unchanged)    | send_pong                                                                              |
| `closing`          | `session.stream.response.failure` (terminal status)               | `expired`      | close stream; clear timers; mark_expired                                               |
| `*` (non-terminal) | `session.destroy`                                                 | `closed`       | close stream; clear all timers; mark_closed                                            |
| `*` (non-terminal) | `session.internal.fatal`                                          | `expired`      | close stream; clear all timers; emit_error; mark_expired                               |
| `closed`           | any                                                               | (unchanged)    | ignored                                                                                |
| `expired`          | any                                                               | (unchanged)    | ignored                                                                                |

### Session FSM invariants (normative)

- `expired` and `closed` are terminal states — no further transitions occur.
- In `expired` or `closed`, `session.signal` MUST be aborted.
- In `expired` or `closed`, new session operations MUST fail fast.
- Transition to `expired` MUST abort all derived resources created from this lifecycle (`Lease`, `Lock`, `Leadership`, `watch`/`observe` iterators).
- `restore_after_reconnect` MUST only be emitted when `ctx.hasEverConnected` was already `true` at the time of the transition — i.e. this is a reconnect, not the first connect.
- `readyDeferred` MUST be replaced with a fresh unresolved deferred on every entry to `reconnecting`, so that any caller waiting in `waitReady()` blocks again rather than seeing the already-resolved promise from a previous `ready` state.
- `ctx.streamIngest` MUST be cleared (set to `null`) when the stream source generator's `finally` block runs, so that the next `openStream` call is not skipped by the "ingest already active" guard.
- `openSession()` MUST create a fresh lifecycle object after terminal expiry; it MUST NOT revive an expired object.
- `withSession()` callback is single-lifecycle scoped and MUST NOT be retried automatically.

---

## API Reference Summary

```typescript
// Client
coordination(driver: Driver): CoordinationClient

// Node management
client.createNode(path, config?, signal?): Promise<void>
client.alterNode(path, config?, signal?): Promise<void>
client.dropNode(path, signal?): Promise<void>
client.describeNode(path, signal?): Promise<CoordinationNodeDescription>

// Session — manual single lifecycle
client.createSession(path, options?, signal?): Promise<CoordinationSession>
// Primary API — lifecycle stream
client.openSession(path, options?, signal?): AsyncIterable<CoordinationSession>
// Callback helper — one lifecycle per invocation, no callback re-run
client.withSession(path, callback, options?, signal?): Promise<T>

// Session
session.signal: AbortSignal          // aborts on explicit close or terminal expiry
session.sessionId: bigint
session.isClosed: boolean
session.status: 'connecting' | 'ready' | 'closing' | 'closed' | 'expired'
session.semaphore(name, options?): Semaphore
session.mutex(name): Mutex
session.election(name): Election
session.close(signal?): Promise<void>
session[Symbol.asyncDispose](): Promise<void>

// Semaphore
semaphore.create(options, signal?): Promise<void>
semaphore.acquire(options?, signal?): Promise<Lease>
semaphore.tryAcquire(options?, signal?): Promise<Lease | null>
semaphore.update(data, signal?): Promise<void>
semaphore.delete(options?, signal?): Promise<void>
semaphore.describe(options?, signal?): Promise<SemaphoreDescription>
semaphore.watch(options?, signal?): AsyncIterable<SemaphoreDescription>

// Lease
lease.name: string
lease.signal: AbortSignal            // derived from session.signal
lease.release(signal?): Promise<void>
lease[Symbol.asyncDispose](): Promise<void>  // → release()

// Mutex
mutex.lock(signal?): Promise<Lock>
mutex.tryLock(signal?): Promise<Lock | null>

// Lock
lock.name: string
lock.signal: AbortSignal             // derived from session.signal
lock.release(signal?): Promise<void>
lock[Symbol.asyncDispose](): Promise<void>   // → release()

// Election
election.campaign(data, signal?): Promise<Leadership>
election.observe(signal?): AsyncIterable<LeaderState>
election.leader(signal?): Promise<LeaderInfo | null>

// Leadership
leadership.signal: AbortSignal       // derived from session.signal
leadership.proclaim(data, signal?): Promise<void>
leadership.resign(signal?): Promise<void>
leadership[Symbol.asyncDispose](): Promise<void>  // → resign()

// LeaderState (from observe)
state.data: Uint8Array
state.isMe: boolean
state.signal: AbortSignal            // aborts when this leader changes

// LeaderInfo (from leader())
info.data: Uint8Array
```
