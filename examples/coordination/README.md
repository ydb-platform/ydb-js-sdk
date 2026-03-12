# @ydbjs/coordination — Examples

Runnable examples for the `@ydbjs/coordination` package.
Each file covers one real-world use case independently.

## Prerequisites

- Node.js >= 20.19
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

Multiple workers compete to become the active leader.
Only one holds leadership at a time. When the leader resigns or its
session expires, the next candidate takes over automatically.

Demonstrates: `election.campaign()`, `leadership.proclaim()`,
`election.observe()`, `election.leader()`

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
then each subsequent update in real time. No stale state after session restart.

Demonstrates: `semaphore.update(data)`, `semaphore.watch({ data: true })`

```bash
npm run shared-config
```

---

### Resource Management with `await using` — `resource-management.js`

Shows the old `try/finally` pattern side by side with the modern `await using`
equivalent for sessions, locks, leases, and leadership. Explains why
`await using` is the right default: disposal is guaranteed by the language,
cleanup order is deterministic (innermost first), and nesting disappears.

Demonstrates: `await using session`, `await using lock`, `await using lease`,
`await using leadership`, error safety, multiple resources in one scope.

```bash
npm run resource-management
```

---

## Further Reading

- [DESIGN.md](../../packages/coordination/DESIGN.md) — architecture, use-case scenarios, design decisions
- [YDB Coordination Service](https://ydb.tech/docs/en/concepts/coordination)
