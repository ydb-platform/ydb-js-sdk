# @ydbjs/coordination

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=coordination)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/packages/coordination/)

Distributed coordination client for [YDB](https://ydb.tech): semaphores, mutexes, and leader elections built on top of YDB coordination nodes.

## Features

- **Distributed semaphores** — acquire tokens with optional data, count, and expiry
- **Distributed mutexes** — exclusive locking via ephemeral semaphores
- **Leader elections** — campaign for leadership and observe leader changes
- **Automatic reconnection** — sessions reconnect transparently; pending operations retry automatically
- **Typed errors** — `SessionClosedError`, `SessionExpiredError`, `LeaseReleasedError`, `LeaderChangedError` for reliable `instanceof` checks
- **Session lifecycle signals** — `session.signal` aborts when the session closes or expires
- **`await using` support** — sessions, leases, locks, and leadership handles implement `Symbol.asyncDispose`

## Installation

```bash
npm install @ydbjs/coordination
```

Requires Node.js `^22.23.5 || ^24.22.3 || >=26.13.1`.

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

using driver = new Driver('grpc://localhost:2136/local')
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

A session yielded by `openSession()` remains caller-owned. Declare `await using activeSession = session` in each loop body so `break`, return, and exceptions close it. The next session is created only after the loop body finishes and the previous session has expired; the iterator does not interrupt application work.

---

## Mutex

A mutex provides exclusive access. Under the hood it acquires all tokens of an ephemeral semaphore — no `createSemaphore` call needed.

### Blocking lock

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  let mutex = activeSession.mutex('job-lock')

  try {
    // Blocks until the lock is acquired.
    await using lock = await mutex.lock()

    console.log('lock acquired — doing exclusive work')
    await doWork(AbortSignal.any([activeSession.signal, lock.signal]))
    // lock.release() called automatically here
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

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
if (lock) {
  await using _ = lock
  await doWork(AbortSignal.any([session.signal, lock.signal]))
} else {
  console.log('mutex is busy — skipping')
}
```

`lock.signal` aborts after a local release succeeds or fails; a release failure becomes its reason. It does not establish whether the server still holds the lock. Use `session.signal` to detect the end of the session.

---

## Semaphore

A semaphore controls access to a shared resource with a configurable token count.

### Create and acquire

```typescript
await using session = await client.createSession('/local/my-app', {}, signal)
let sem = session.semaphore('connections')

// Provision once; create() rejects if the semaphore already exists.
await sem.create({ limit: 10 })

// Acquire one token — blocks until available
await using lease = await sem.acquire({ count: 1 })
await doWork(AbortSignal.any([session.signal, lease.signal]))
// lease.release() called automatically here
```

Once the server acknowledges an acquisition, cancelling its operation signal does not revoke ownership. The acknowledged lease is returned so it can be released or disposed. Destroying the session still rejects pending acquisitions and prevents returning new leases.

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
if (lease) {
  await using _ = lease
} else {
  console.log('semaphore at capacity')
}
```

### Watch for changes

`watch()` yields the current state and watches the requested fields. Changes may be coalesced; this is a state subscription, not an event log. After session expiry, start a new watch on the next session from `openSession()`.

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  let sem = activeSession.semaphore('config')

  try {
    for await (let desc of sem.watch({ data: true })) {
      let config = JSON.parse(new TextDecoder().decode(desc.data))
      console.log('config updated:', config)
    }
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

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

Create the election semaphore once during provisioning, before starting candidates. `campaign()` does not create it. Repeating this setup for an existing semaphore returns `ALREADY_EXISTS`.

```ts
{
  await using setup = await client.createSession('/local/my-app', {})
  await setup.semaphore('primary').create({ limit: 1 })
}
```

### Campaign for leadership

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  let election = activeSession.election('primary')

  try {
    // Blocks until this session wins. Attach initial leader data (e.g. endpoint).
    await using leadership = await election.campaign(utf8.encode('worker-a:8080'))

    console.log('elected — doing leader work')

    await doLeaderWork(AbortSignal.any([activeSession.signal, leadership.signal]))

    // leadership.resign() called automatically here
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

    throw error
  }

  break
}
```

`leadership.signal` reflects the local lease release; it does not abort on session expiry by itself. Combine it with `session.signal` for leader work. `proclaim(data)` updates semaphore-level data, while `leader()` and `observe()` return the owner data supplied to `campaign()`. Use `semaphore.watch({ data: true })` to observe semaphore-level updates.

### Observe leader changes

```typescript
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  let election = activeSession.election('primary')

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
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

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

Sessions, locks, and leases implement `Symbol.asyncDispose` for graceful cleanup with `await using`.

For a session, `close()` sends `SessionStop` and waits for the server to acknowledge it or close the stream. `destroy()` immediately cancels the stream, clears timers and queued watch notifications, and rejects pending operations. A destroyed session cannot be reused. `using session` calls `destroy()`; `await using session` calls `close()`.

Create the persistent `quota` semaphore once with a positive limit before running this example; acquiring a lease does not create it.

```typescript
// Session, lock, and lease released in reverse declaration order —
// guaranteed even if an exception is thrown.
await using session = await client.createSession('/local/my-app', {}, signal)
await using _lock = await session.mutex('job').lock()
await using _lease = await session.semaphore('quota').acquire({ count: 1 })

await doWork(session.signal)
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
| `startTimeout`   | `number` (ms) | `3_000`  | Timeout for the initial session handshake                     |
| `retryBackoff`   | `number` (ms) | `30`     | Base delay between reconnect attempts                         |

---

## Error classes

All error classes are exported from `@ydbjs/coordination` and can be checked with `instanceof`.

| Error                   | When                                                      | Found in                                |
| ----------------------- | --------------------------------------------------------- | --------------------------------------- |
| `SessionClosedError`    | Session was closed (gracefully or destroyed)              | `session.signal.reason`                 |
| `SessionExpiredError`   | Recovery window expired — server dropped the session      | `session.signal.reason`                 |
| `LeaseReleasedError`    | Semaphore lease was released                              | `lease.signal.reason`                   |
| `LeaderChangedError`    | A new leader replaced the previous one during `observe()` | `LeaderState.signal.reason`             |
| `ObservationEndedError` | The `observe()` async iterator finished                   | `LeaderState.signal.reason`             |
| `TryAcquireMissError`   | Non-blocking acquire found no available tokens (internal) | thrown by `acquire({ waitTimeout: 0 })` |

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
