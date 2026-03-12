---
title: Coordination — Overview
---

# Coordination (@ydbjs/coordination)

Distributed coordination primitives for YDB: semaphores, mutexes, and leader elections built on top of YDB coordination nodes.

## Quick start

```ts
import { Driver } from '@ydbjs/core'
import { CoordinationClient } from '@ydbjs/coordination'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
const client = new CoordinationClient(driver)

// Create a coordination node once during provisioning
await client.createNode('/local/my-app', {})

// Acquire an exclusive lock
await using session = await client.createSession('/local/my-app', {})
await using lock = await session.mutex('job-lock').lock()

await doWork(lock.signal)
// lock.release()  ← called automatically
// session.close() ← called automatically
```

## Session types

| Method            | Use when                                                            |
| ----------------- | ------------------------------------------------------------------- |
| `createSession()` | One-off operation: the session is ready when the promise resolves   |
| `openSession()`   | Long-running work: automatically recreates the session after expiry |
| `withSession()`   | Callback style with guaranteed cleanup                              |

`openSession()` is the preferred choice for services that run continuously.
When the server expires a session (e.g. due to a network partition), `openSession()` automatically
creates a new one and re-enters the loop body — no manual reconnect logic needed.

```ts
const ctrl = new AbortController()

for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  ctrl.signal
)) {
  try {
    await doWork(session)
  } catch {
    if (session.signal.aborted) continue // session expired — retry
    throw error
  }

  break // exit after one successful cycle
}
```

`session.signal` aborts the moment the session expires on the server, so any downstream
operation that accepted the signal will cancel automatically.

## Mutex

A mutex provides exclusive access across sessions. Under the hood it acquires all tokens of an
ephemeral semaphore — no `createSemaphore` call is needed.

### Blocking lock

```ts
for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    await using lock = await session.mutex('job-lock').lock()

    await doWork(lock.signal)
    // lock.release() called automatically
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### Non-blocking try

`tryLock()` returns `null` immediately if the mutex is already held by another session.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)

const lock = await session.mutex('job-lock').tryLock()
if (!lock) {
  console.log('mutex busy — skipping')
  return
}

await using _ = lock
await doWork(lock.signal)
```

`lock.signal` aborts when the lock is lost (e.g. session expired), so you can pass it to
downstream operations to have them cancel automatically.

## Semaphore

A semaphore controls concurrent access with a configurable token count.

### Create and acquire

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
const sem = session.semaphore('connections')

// Create once (catch AlreadyExists if it may already exist)
await sem.create({ limit: 10 })

// Acquire one token — blocks until a token is available
await using lease = await sem.acquire({ count: 1 })
await doWork(lease.signal)
// lease.release() called automatically
```

### Ephemeral semaphore

With `ephemeral: true` the server creates the semaphore on first acquire and deletes it when
the last token is released — no prior `create()` call needed.

```ts
const utf8 = new TextEncoder()

await using lease = await sem.acquire({
  count: 1,
  ephemeral: true,
  data: utf8.encode('worker-a:8080'), // optional per-token metadata
})
```

### Non-blocking try

```ts
const lease = await sem.tryAcquire({ count: 1 })
if (!lease) {
  console.log('semaphore at capacity')
  return
}

await using _ = lease
await doWork(lease.signal)
```

### Watch for changes

`watch()` yields immediately with the current state and then again on every server-side change.
After a session restart it delivers the latest state first — no stale data, no missed updates.

```ts
for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    for await (const desc of session.semaphore('config').watch({ data: true })) {
      const config = JSON.parse(new TextDecoder().decode(desc.data))
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

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
await session.semaphore('config').update(new TextEncoder().encode(JSON.stringify({ version: 2 })))
```

## Election

An election is a named semaphore where exactly one session can hold the single token at a time.
The holder is the leader.

### Campaign for leadership

`campaign()` blocks until this session wins the election.

```ts
const utf8 = new TextEncoder()

for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    await using leadership = await session.election('primary').campaign(
      utf8.encode('worker-a:8080') // initial leader data (e.g. endpoint)
    )

    console.log('elected — starting leader work')

    // Update leader data without re-election; all observers see it immediately.
    await leadership.proclaim(utf8.encode('worker-a:9090'))

    // leadership.signal aborts when leadership is lost (session expired, resigned).
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

`observe()` yields on every leader change: new leader elected, leader data updated via
`proclaim()`, or leader resigned. `state.signal` aborts when the leader changes, making it
easy to scope work to a single leadership term.

```ts
for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    for await (const state of session.election('primary').observe()) {
      if (!state.data.length) {
        console.log('no leader')
        continue
      }

      const endpoint = new TextDecoder().decode(state.data)
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

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
const leader = await session.election('primary').leader()
if (leader) {
  console.log('leader:', new TextDecoder().decode(leader.data))
}
```

## Resource management with `await using`

Every resource implements `Symbol.asyncDispose`, making `await using` the safest way to
manage lifetimes. Resources are disposed in reverse declaration order — guaranteed even if
an exception is thrown.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
await using _lock = await session.mutex('job').lock()
await using _lease = await session.semaphore('quota').acquire({ count: 1 })

await doWork()
// _lease.release()  ← first
// _lock.release()   ← second
// session.close()   ← last
```

Without `await using` the equivalent requires nested `try/finally` blocks — one per resource.
`await using` eliminates nesting and makes forgetting to clean up impossible.

## Node management

```ts
const client = new CoordinationClient(driver)

// Create a coordination node (server-side container for sessions and semaphores)
await client.createNode('/local/my-app', {})

// Describe current node configuration
const desc = await client.describeNode('/local/my-app')

// Update node configuration
await client.alterNode('/local/my-app', { selfCheckPeriod: 1000 })

// Delete node (fails if active sessions exist)
await client.dropNode('/local/my-app')
```

## Session options

| Option           | Type          | Default  | Description                                                   |
| ---------------- | ------------- | -------- | ------------------------------------------------------------- |
| `recoveryWindow` | `number` (ms) | `30_000` | How long the server preserves the session during a disconnect |
| `description`    | `string`      | `''`     | Human-readable label visible in server diagnostics            |
| `startTimeout`   | `number` (ms) | —        | Timeout for the initial session handshake                     |
| `retryBackoff`   | `number` (ms) | —        | Base delay between reconnect attempts                         |

## Examples {#examples}

### Mutex: exclusive job lock {#examples-mutex}

```ts
// Two workers compete — only one runs at a time.
async function runWorker(id: string, signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      await using lock = await session.mutex('job').lock()
      console.log(`worker-${id}: lock acquired`)
      await doWork(lock.signal)
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}

await Promise.all([runWorker('a', ctrl.signal), runWorker('b', ctrl.signal)])
```

### Service discovery: ephemeral endpoint registration {#examples-service-discovery}

```ts
const utf8 = new TextEncoder()
const text = new TextDecoder()

// Worker: register while the session lives; deregisters automatically on expiry.
async function register(endpoint: string, signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      await using _lease = await session.semaphore('endpoints').acquire({
        count: 1,
        ephemeral: true,
        data: utf8.encode(endpoint),
      })
      await waitForAbort(session.signal)
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}

// Watcher: observe live endpoint list.
async function watch(signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      for await (const desc of session.semaphore('endpoints').watch({ owners: true })) {
        const endpoints = (desc.owners ?? []).map((o) => text.decode(o.data))
        console.log('available:', endpoints)
      }
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}
```

### Shared config: real-time distribution {#examples-shared-config}

```ts
// Publisher: one-shot update.
async function publish(config: object, signal: AbortSignal) {
  await using session = await client.createSession('/local/my-app', {}, signal)
  await session.semaphore('config').update(new TextEncoder().encode(JSON.stringify(config)))
}

// Subscriber: receive current value immediately, then every change.
async function subscribe(signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      for await (const desc of session.semaphore('config').watch({ data: true })) {
        console.log('config:', JSON.parse(new TextDecoder().decode(desc.data)))
      }
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}
```

### Leader election with failover {#examples-election}

```ts
const utf8 = new TextEncoder()
const text = new TextDecoder()

// Candidate: campaigns and holds leadership until the session expires.
async function runCandidate(name: string, signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      await using leadership = await session.election('primary').campaign(utf8.encode(name))
      console.log(`${name}: elected`)
      await waitForAbort(leadership.signal) // hold until lost
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}

// Observer: reacts to leader changes.
async function observe(signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      for await (const state of session.election('primary').observe()) {
        const leader = state.data.length ? text.decode(state.data) : '(none)'
        console.log('leader:', leader, state.isMe ? '← me' : '')
      }
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}
```

## Further reading

- [YDB Coordination Nodes](https://ydb.tech/docs/en/reference/ydb-sdk/coordination)
- [Leader Election Recipe](https://ydb.tech/docs/en/recipes/ydb-sdk/leader-election)
- [Service Discovery Recipe](https://ydb.tech/docs/en/recipes/ydb-sdk/service-discovery)
- [Configuration Publication Recipe](https://ydb.tech/docs/en/recipes/ydb-sdk/config-publication)
- [Runnable examples](https://github.com/ydb-platform/ydb-js-sdk/tree/main/examples/coordination)
