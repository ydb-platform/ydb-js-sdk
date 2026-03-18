# @ydbjs/coordination

Distributed coordination client for [YDB](https://ydb.tech): semaphores, mutexes, and leader elections built on top of YDB coordination nodes.

## Features

- **Distributed semaphores** — acquire tokens with optional data, count, and expiry
- **Distributed mutexes** — exclusive locking via ephemeral semaphores
- **Leader elections** — campaign for leadership and observe leader changes
- **Automatic reconnection** — sessions reconnect transparently; pending operations retry automatically
- **Typed errors** — `SessionClosedError`, `SessionExpiredError`, `LeaseReleasedError`, `LeaderChangedError` for reliable `instanceof` checks
- **Session lifecycle signals** — `session.signal` aborts when the session closes or expires
- **`await using` support** — all resources implement `Symbol.asyncDispose`

## Installation

```bash
npm install @ydbjs/coordination
```

Requires Node.js >= 20.19.

## Overview

```
CoordinationClient
  └── createNode / dropNode / describeNode / alterNode   — node management
  └── createSession()     → CoordinationSession          — one-shot, ready immediately
  └── openSession()       → AsyncIterable<Session>       — auto-reconnect loop
  └── withSession()       → Promise<T>                   — callback with cleanup

CoordinationSession
  └── mutex(name)         → Mutex                        — exclusive lock
  └── semaphore(name)     → Semaphore                    — counting semaphore
  └── election(name)      → Election                     — leader election
  └── session.signal                                     — aborts on session expiry
  └── session.sessionId                                  — current server session ID
```

## Getting Started

### Create a client

```typescript
import { Driver } from '@ydbjs/core'
import { CoordinationClient } from '@ydbjs/coordination'

let driver = new Driver('grpc://localhost:2136/local')
let client = new CoordinationClient(driver)

// Create a coordination node (once, during provisioning)
await client.createNode('/local/my-app', {})
```

### Session types

| Method            | Use when                                                            |
| ----------------- | ------------------------------------------------------------------- |
| `createSession()` | One-off operation: the session is ready when the promise resolves   |
| `openSession()`   | Long-running work: automatically recreates the session after expiry |
| `withSession()`   | Callback style with guaranteed cleanup                              |

---

## Mutex

A mutex provides exclusive access. Under the hood it acquires all tokens of an ephemeral semaphore — no `createSemaphore` call needed.

### Blocking lock

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  let mutex = session.mutex('job-lock')

  try {
    // Blocks until the lock is acquired.
    await using lock = await mutex.lock()

    console.log('lock acquired — doing exclusive work')
    await doWork(lock.signal)
    // lock.release() called automatically here
  } catch {
    if (session.signal.aborted) continue // session expired, retry
    throw error
  }

  break
}
```

### Non-blocking try

```typescript
await using session = await client.createSession('/local/my-app', {}, signal)
let mutex = session.mutex('job-lock')

let lock = await mutex.tryLock()
if (!lock) {
  console.log('mutex is busy — skipping')
  return
}

await using _ = lock
await doWork(lock.signal)
```

`lock.signal` aborts when the lock is released. Use `session.signal` to detect session death.

---

## Semaphore

A semaphore controls access to a shared resource with a configurable token count.

### Create and acquire

```typescript
await using session = await client.createSession('/local/my-app', {}, signal)
let sem = session.semaphore('connections')

// Create once (idempotent — catch if already exists)
await sem.create({ limit: 10 })

// Acquire one token — blocks until available
await using lease = await sem.acquire({ count: 1 })
await doWork(lease.signal)
// lease.release() called automatically here
```

### Ephemeral semaphore (no prior create needed)

```typescript
// ephemeral: true — the server creates the semaphore automatically
// and deletes it when the last token is released
await using lease = await sem.acquire({
  count: 1,
  ephemeral: true,
  data: utf8.encode('worker-a:8080'), // optional per-token metadata
})
```

### Non-blocking try

```typescript
let lease = await sem.tryAcquire({ count: 1 })
if (!lease) {
  console.log('semaphore at capacity')
  return
}
await using _ = lease
```

### Watch for changes

`watch()` yields immediately with the current state, then again on every server-side change. Reconnects automatically after session expiry.

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  let sem = session.semaphore('config')

  try {
    for await (let desc of sem.watch({ data: true })) {
      let config = JSON.parse(new TextDecoder().decode(desc.data))
      console.log('config updated:', config)
    }
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### Update semaphore data

```typescript
await using session = await client.createSession('/local/my-app', {}, signal)
await session.semaphore('config').update(utf8.encode(JSON.stringify({ version: 2 })))
```

---

## Election

An election is a named semaphore where exactly one session can hold the single token. The holder is the leader.

### Campaign for leadership

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  let election = session.election('primary')

  try {
    // Blocks until this session wins. Attach initial leader data (e.g. endpoint).
    await using leadership = await election.campaign(utf8.encode('worker-a:8080'))

    console.log('elected — doing leader work')

    // Update leader data without re-election.
    await leadership.proclaim(utf8.encode('worker-a:9090'))

    // leadership.signal aborts when leadership is lost.
    await doLeaderWork(leadership.signal)

    // leadership.resign() called automatically here
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### Observe leader changes

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  let election = session.election('primary')

  try {
    // Yields on every leader change. state.signal aborts when the leader changes.
    for await (let state of election.observe()) {
      if (!state.data.length) {
        console.log('no leader')
        continue
      }

      let endpoint = new TextDecoder().decode(state.data)
      console.log(state.isMe ? 'i am leader:' : 'current leader:', endpoint)
    }
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### One-shot leader query

```typescript
await using session = await client.createSession('/local/my-app', {}, signal)
let leader = await session.election('primary').leader()
if (leader) {
  console.log('leader:', new TextDecoder().decode(leader.data))
}
```

---

## Resource management with `await using`

Every resource in this package implements `Symbol.asyncDispose`, making `await using` the safest and most concise way to manage lifetimes.

```typescript
// Session, lock, and lease released in reverse declaration order —
// guaranteed even if an exception is thrown.
await using session = await client.createSession('/local/my-app', {}, signal)
await using _lock = await session.mutex('job').lock()
await using _lease = await session.semaphore('quota').acquire({ count: 1 })

await doWork()
// _lease.release()  ← first
// _lock.release()   ← second
// session.close()   ← last
```

Without `await using`, the equivalent requires nested `try/finally` blocks — one per resource. `await using` eliminates nesting and makes forgetting to clean up impossible.

---

## Node management

```typescript
let client = new CoordinationClient(driver)

// Create a coordination node (server-side container for sessions/semaphores)
await client.createNode('/local/my-app', {})

// Describe current node configuration
let desc = await client.describeNode('/local/my-app')

// Update node configuration
await client.alterNode('/local/my-app', { selfCheckPeriod: 1000 })

// Delete node (fails if sessions are active)
await client.dropNode('/local/my-app')
```

---

## Session options

| Option           | Type          | Default  | Description                                                   |
| ---------------- | ------------- | -------- | ------------------------------------------------------------- |
| `recoveryWindow` | `number` (ms) | `30_000` | How long the server preserves the session during a disconnect |
| `description`    | `string`      | `''`     | Human-readable label visible in server diagnostics            |
| `startTimeout`   | `number` (ms) | —        | Timeout for the initial session handshake                     |
| `retryBackoff`   | `number` (ms) | —        | Base delay between reconnect attempts                         |

---

## Error classes

All error classes are exported from `@ydbjs/coordination` and can be checked with `instanceof`.

| Error                   | When                                                      | Found in                            |
| ----------------------- | --------------------------------------------------------- | ----------------------------------- |
| `SessionClosedError`    | Session was closed (gracefully or destroyed)              | `session.signal.reason`             |
| `SessionExpiredError`   | Recovery window expired — server dropped the session      | `session.signal.reason`             |
| `LeaseReleasedError`    | Semaphore lease was released                              | `lease.signal.reason`               |
| `LeaderChangedError`    | A new leader replaced the previous one during `observe()` | `LeaderState.signal.reason`         |
| `ObservationEndedError` | The `observe()` async iterator finished                   | `LeaderState.signal.reason`         |
| `TryAcquireMissError`   | Non-blocking acquire found no available tokens (internal) | thrown by `acquire(waitTimeout: 0)` |

```typescript
import { SessionExpiredError, LeaseReleasedError } from '@ydbjs/coordination'

session.signal.addEventListener('abort', () => {
  if (session.signal.reason instanceof SessionExpiredError) {
    console.log('session expired — will reconnect')
  }
})

lease.signal.addEventListener('abort', () => {
  if (lease.signal.reason instanceof LeaseReleasedError) {
    console.log('lease released normally')
  }
})
```

---

## Examples

Runnable examples covering common patterns are in [`examples/coordination/`](../../examples/coordination/):

| File                     | What it shows                                           |
| ------------------------ | ------------------------------------------------------- |
| `mutex.js`               | Exclusive locking with `lock()` and `tryLock()`         |
| `election.js`            | Leader election with `campaign()` and `observe()`       |
| `service-discovery.js`   | Dynamic endpoint registration with ephemeral semaphores |
| `shared-config.js`       | Real-time configuration distribution via `watch()`      |
| `resource-management.js` | `await using` vs `try/finally` side by side             |

---

## Documentation

- [YDB Coordination Nodes](https://ydb.tech/docs/en/reference/ydb-sdk/coordination)
- [Leader Election Recipe](https://ydb.tech/docs/en/recipes/ydb-sdk/leader-election)
- [Service Discovery Recipe](https://ydb.tech/docs/en/recipes/ydb-sdk/service-discovery)
- [Configuration Publication Recipe](https://ydb.tech/docs/en/recipes/ydb-sdk/config-publication)

## License

Apache-2.0
