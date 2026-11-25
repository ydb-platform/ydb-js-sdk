---
title: Coordination — Overview
---

# Coordination (@ydbjs/coordination)

Distributed coordination primitives for YDB: semaphores, mutexes, and leader elections built on top of YDB coordination nodes.

## Quick start

```ts
import { Driver } from '@ydbjs/core'
import { CoordinationClient } from '@ydbjs/coordination'

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
let client = new CoordinationClient(driver)

// Create a coordination node once during provisioning
await client.createNode('/local/my-app', {})

// Acquire an exclusive lock
await using session = await client.createSession('/local/my-app', {})
await using lock = await session.mutex('job-lock').lock()

await doWork(AbortSignal.any([session.signal, lock.signal]))
// lock.release()  ← called automatically
// session.close() ← called automatically
```

## Session types

| Method            | Use when                                                            |
| ----------------- | ------------------------------------------------------------------- |
| `createSession()` | One-off operation: the session is ready when the promise resolves   |
| `openSession()`   | Long-running work: automatically recreates the session after expiry |
| `withSession()`   | Callback style with guaranteed cleanup                              |

A session yielded by `openSession()` remains caller-owned. Declare `await using activeSession = session` in each loop body so `break`, return, and exceptions close it. The next session is created only after the loop body finishes and the previous session has expired; the iterator does not interrupt application work.

`openSession()` is the preferred choice for services that run continuously.
When the server expires a session (e.g. due to a network partition), `openSession()` automatically
creates a new one and re-enters the loop body — no manual reconnect logic needed.

```ts
let ctrl = new AbortController()

for await (let session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  ctrl.signal
)) {
  await using activeSession = session

  try {
    await doWork(activeSession.signal)
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

    throw error
  }

  break // exit after one successful cycle
}
```

`session.signal` aborts when the client detects session expiry or closes the session. It does not report the exact instant when the server loses the session. Pass it to work that must stop when the local session ends.

## Mutex

A mutex provides exclusive access across sessions. Under the hood it acquires all tokens of an
ephemeral semaphore — no `createSemaphore` call is needed.

### Blocking lock

```ts
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    await using lock = await activeSession.mutex('job-lock').lock()

    await doWork(AbortSignal.any([activeSession.signal, lock.signal]))
    // lock.release() called automatically
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

`tryLock()` returns `null` immediately if the mutex is already held by another session.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)

let lock = await session.mutex('job-lock').tryLock()
if (lock) {
  await using _ = lock
  await doWork(AbortSignal.any([session.signal, lock.signal]))
} else {
  console.log('mutex busy — skipping')
}
```

`lock.signal` aborts after a local release succeeds or fails; a release failure becomes its reason. It does not establish whether the server still holds the lock. Use `session.signal` to detect the end of the session.

## Semaphore

A semaphore controls concurrent access with a configurable token count.

### Create and acquire

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
let sem = session.semaphore('connections')

// Provision once; create() rejects if the semaphore already exists.
await sem.create({ limit: 10 })

// Acquire one token — blocks until a token is available
await using lease = await sem.acquire({ count: 1 })
await doWork(AbortSignal.any([session.signal, lease.signal]))
// lease.release() called automatically
```

### Ephemeral semaphore

With `ephemeral: true` the server creates the semaphore on first acquire and deletes it when
the last token is released — no prior `create()` call needed.

```ts
let utf8 = new TextEncoder()

await using lease = await sem.acquire({
  count: 1,
  ephemeral: true,
  data: utf8.encode('worker-a:8080'), // optional per-token metadata
})
```

### Non-blocking try

```ts
let lease = await sem.tryAcquire({ count: 1 })
if (lease) {
  await using _ = lease
  await doWork(AbortSignal.any([session.signal, lease.signal]))
} else {
  console.log('semaphore at capacity')
}
```

### Watch for changes

`watch()` yields the current state and watches the requested fields. Changes may be coalesced; this is a state subscription, not an event log. After session expiry, start a new watch on the next session from `openSession()`.

```ts
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    for await (let desc of activeSession.semaphore('config').watch({ data: true })) {
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

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
await session.semaphore('config').update(new TextEncoder().encode(JSON.stringify({ version: 2 })))
```

## Election

An election is a named semaphore where exactly one session can hold the single token at a time.
The holder is the leader.

Create the election semaphore once during provisioning, before starting candidates. `campaign()` does not create it. Repeating this setup for an existing semaphore returns `ALREADY_EXISTS`.

```ts
{
  await using setup = await client.createSession('/local/my-app', {})
  await setup.semaphore('primary').create({ limit: 1 })
}
```

### Campaign for leadership

`campaign()` blocks until this session wins the election.

```ts
let utf8 = new TextEncoder()

for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    await using leadership = await activeSession.election('primary').campaign(
      utf8.encode('worker-a:8080') // initial leader data (e.g. endpoint)
    )

    console.log('elected — starting leader work')

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

`observe()` emits changes in the observed owner identity (`sessionId` and acquisition order), and the absence of an owner after a leader leaves. `state.signal` aborts when the iterator observes another owner or finishes. The iterator must keep advancing to receive changes; use `session.signal` as well for session lifetime.

```ts
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    for await (let state of activeSession.election('primary').observe()) {
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

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
let leader = await session.election('primary').leader()
if (leader) {
  console.log('leader:', new TextDecoder().decode(leader.data))
}
```

## Resource management with `await using`

Every resource implements `Symbol.asyncDispose`, making `await using` the safest way to
manage lifetimes. Resources are disposed in reverse declaration order — guaranteed even if
an exception is thrown.

Create the persistent `quota` semaphore once with a positive limit before running this example; acquiring a lease does not create it.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
await using _lock = await session.mutex('job').lock()
await using _lease = await session.semaphore('quota').acquire({ count: 1 })

await doWork(session.signal)
// _lease.release()  ← first
// _lock.release()   ← second
// session.close()   ← last
```

Without `await using` the equivalent requires nested `try/finally` blocks — one per resource.
`await using` eliminates nesting and makes forgetting to clean up impossible.

## Node management

```ts
let client = new CoordinationClient(driver)

// Create a coordination node (server-side container for sessions and semaphores)
await client.createNode('/local/my-app', {})

// Describe current node configuration
let desc = await client.describeNode('/local/my-app')

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
| `startTimeout`   | `number` (ms) | `3_000`  | Timeout for the initial session handshake                     |
| `retryBackoff`   | `number` (ms) | `30`     | Base delay between reconnect attempts                         |

## Examples {#examples}

`doWork(signal)`, `doLeaderWork(signal)`, and `waitForAbort(signal)` below stand for application functions. They must reject when the signal aborts, including when it was already aborted before the call.

### Mutex: exclusive job lock {#examples-mutex}

```ts
// Two workers compete — only one runs at a time.
async function runWorker(id: string, signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      await using lock = await activeSession.mutex('job').lock()
      console.log(`worker-${id}: lock acquired`)
      await doWork(AbortSignal.any([activeSession.signal, lock.signal]))
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}

await Promise.all([runWorker('a', ctrl.signal), runWorker('b', ctrl.signal)])
```

### Service discovery: ephemeral endpoint registration {#examples-service-discovery}

```ts
let utf8 = new TextEncoder()
let text = new TextDecoder()

// Worker: register while the session lives; deregisters automatically on expiry.
async function register(endpoint: string, signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      await using _lease = await activeSession.semaphore('endpoints').acquire({
        count: 1,
        ephemeral: true,
        data: utf8.encode(endpoint),
      })
      await waitForAbort(activeSession.signal)
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}

// Watcher: observe live endpoint list.
async function watch(signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      for await (let desc of activeSession.semaphore('endpoints').watch({ owners: true })) {
        let endpoints = (desc.owners ?? []).map((owner) => {
          return text.decode(owner.data)
        })
        console.log('available:', endpoints)
      }
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}
```

### Shared config: real-time distribution {#examples-shared-config}

Create the persistent `config` semaphore once with `limit: 1` and initial JSON data, such as `new TextEncoder().encode('{}')`, before starting these functions. Neither `update()` nor `watch()` creates it.

```ts
// Publisher: one-shot update.
async function publish(config: object, signal: AbortSignal) {
  await using session = await client.createSession('/local/my-app', {}, signal)
  await session.semaphore('config').update(new TextEncoder().encode(JSON.stringify(config)))
}

// Subscriber: receive current value immediately, then every change.
async function subscribe(signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      for await (let desc of activeSession.semaphore('config').watch({ data: true })) {
        console.log('config:', JSON.parse(new TextDecoder().decode(desc.data)))
      }
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}
```

### Leader election with failover {#examples-election}

```ts
let utf8 = new TextEncoder()
let text = new TextDecoder()

// Candidate: campaigns and holds leadership until the session expires.
async function runCandidate(name: string, signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      await using leadership = await activeSession.election('primary').campaign(utf8.encode(name))
      console.log(`${name}: elected`)
      await waitForAbort(AbortSignal.any([activeSession.signal, leadership.signal]))
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}

// Observer: reacts to leader changes.
async function observe(signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      for await (let state of activeSession.election('primary').observe()) {
        let leader = state.data.length ? text.decode(state.data) : '(none)'
        console.log('leader:', leader, state.isMe ? '← me' : '')
      }
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

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
