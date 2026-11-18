# @ydbjs/coordination — Examples

Runnable examples for the `@ydbjs/coordination` package.
Each file covers one real-world use case independently.

## Prerequisites

- Node.js `^22.23.5 || ^24.22.3 || >=26.13.1`
- Running YDB instance (local or remote)
- Built packages (run `npm run build` from the repository root)

## Setup

```bash
# From the repository root
npm install
npm run build

cd examples/coordination
```

Set the connection string if your YDB is not on the default local address:

```bash
export YDB_CONNECTION_STRING=grpc://localhost:2136/local
```

## Examples

### Leader Election — `election.js`

One candidate acquires leadership while another session observes the elected endpoint and resignation. Each run creates and removes its own coordination node.

`leadership.signal` alone does not detect session expiry; leader work must also use `session.signal`. `proclaim()` changes semaphore-level data, while `leader()` and `observe()` return acquisition metadata. The example combines the session and lease signals for leader work and uses a fresh coordination node for each run.

Demonstrates: `election.campaign()`, `election.observe()`, `election.leader()`

```bash
npm run election
```

---

### Distributed Mutex — `mutex.js`

Multiple workers compete for an exclusive lock.
Only one runs the critical section at a time. The mutex is backed by an
ephemeral semaphore — no setup needed, the server creates it automatically.

Demonstrates: `mutex.lock()`, `mutex.tryLock()`

```bash
npm run mutex
```

---

### Service Discovery — `service-discovery.js`

Workers register their endpoints on startup using an ephemeral semaphore token.
A watcher maintains a live endpoint list. When a worker's session expires,
its endpoint disappears from the list automatically — no explicit deregistration.

Demonstrates: `semaphore.acquire({ ephemeral: true })`,
`semaphore.watch({ owners: true })`

```bash
npm run service-discovery
```

---

### Shared Configuration — `shared-config.js`

A publisher pushes config updates into a semaphore's data field.
All watchers receive the current value immediately on connect,
then the latest observed state after changes. Updates can be coalesced; this is not a durable event log.

Demonstrates: `semaphore.update(data)`, `semaphore.watch({ data: true })`

```bash
npm run shared-config
```

---

### Resource Management — `resource-management.js`

Demonstrates nested `try/finally` cleanup for sessions, locks, leases, and leadership, including failure paths and reverse acquisition order. The JavaScript examples run directly on the supported Node.js 22 release line, where native `using` syntax is unavailable. TypeScript examples in the [package README](../../packages/coordination/README.md) show the equivalent `await using` form after compilation.

```bash
npm run resource-management
```

---

## Further Reading

- [Package README](../../packages/coordination/README.md) — setup, session ownership, and signal semantics
- [YDB Coordination Service](https://ydb.tech/docs/en/concepts/coordination)
