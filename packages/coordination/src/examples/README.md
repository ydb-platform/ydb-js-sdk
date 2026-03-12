# @ydbjs/coordination v2 examples

This directory contains small usage examples for the `v2` coordination API.

The goal of these examples is to show the intended DX and lifecycle rules for `CoordinationSession`-based code:

- one `CoordinationSession` object represents exactly one server-side session lifecycle
- if `session.signal` is aborted, all work derived from that session must stop
- reconnects inside the recovery window are transparent for session-scoped objects
- if the session expires, you must create a new session or continue with `openSession()`
- `Mutex`, `Election`, config watchers, and similar helpers are recipes over `Semaphore`

## Core ideas

## `createSession()`

Use `createSession()` when you want one explicit session lifecycle.

This mode is good for:

- one-shot scripts
- setup operations
- admin actions
- tests with manual lifecycle control

Example shape:

```ts
let session = await client.createSession('/local/coordination')

try {
  let mutex = session.mutex('jobs')
  await using lock = await mutex.lock()

  await doWork({ signal: lock.signal })
} finally {
  await session.close()
}
```

Important rule:

- if `session.signal.aborted === true`, stop using everything created from that session

That includes:

- `Semaphore`
- `Lease`
- `Mutex`
- `Lock`
- `Election`
- `Leadership`
- active `watch()` and `observe()` iterators

## `openSession()`

Use `openSession()` for long-running workers.

This is the safer production mode because it gives you a fresh `CoordinationSession` after terminal expiry.

Example shape:

```ts
for await (let session of client.openSession('/local/coordination')) {
  let election = session.election('leader')

  try {
    await using leadership = await election.campaign(new TextEncoder().encode('worker-a'))

    await runLeaderLoop({ signal: leadership.signal })
  } catch (error) {
    if (session.signal.aborted) {
      continue
    }

    throw error
  }
}
```

Each iteration is a new lifecycle boundary.

Do not carry session-derived objects between iterations.

## `withSession()`

Use `withSession()` when you want callback-scoped resource handling.

Example shape:

```ts
await client.withSession('/local/coordination', async (session) => {
  let semaphore = session.semaphore('init-lock')

  await using lease = await semaphore.acquire({ count: 1 })
  await initialize({ signal: lease.signal })
})
```

Everything created inside the callback must stay inside that callback.

## Transparent reconnects

Temporary transport reconnects are normal in a distributed system.

If reconnect happens inside the recovery window:

- the session object stays the same
- `session.signal` does not abort
- active session-scoped handles remain valid
- watch subscriptions are restored internally

This means your code should usually treat reconnects as invisible infrastructure events.

## Terminal expiry

If the recovery window is exceeded or the server confirms session death:

- the session lifecycle becomes terminal
- `session.signal` aborts
- all derived resource signals abort
- active operations stop
- the session object must never be reused

With `createSession()`, you create a new session manually.

With `openSession()`, you continue in the next iteration.

## Example scenarios

The examples in this folder are expected to cover these common patterns:

- simple semaphore usage
- mutex-style critical section
- leader election loop
- configuration watch
- worker pattern with `openSession()`

## Recommended review checklist

When reviewing examples or implementation, check that they follow these rules:

- no reuse of handles after `session.signal` abort
- no reuse of objects across `openSession()` iterations
- graceful shutdown uses `close()`
- immediate shutdown uses `destroy()`
- long-running work uses the derived resource signal, not just the outer session signal

## Notes

This folder documents the intended `v2` API behavior.

It is especially useful when comparing old coordination implementation ideas with the new FSM-oriented session model.
