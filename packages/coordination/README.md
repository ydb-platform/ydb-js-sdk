# @ydbjs/coordination

High-level coordination client for YDB. Supports coordination nodes, distributed semaphores, and distributed locking patterns.

## Features

- Coordination node management (create, alter, drop, describe)
- Distributed semaphores with acquire/release operations
- Automatic resource cleanup with TypeScript `using` keyword
- Automatic session lifecycle with keep-alive and reconnection
- Watch notifications for semaphore changes via EventEmitter
- Automatic session recreation on session expiring

## Installation

```bash
npm install @ydbjs/coordination
```

Requires Node.js >= 20.19.

## Getting Started

```typescript
import { Driver } from '@ydbjs/core'
import { coordination } from '@ydbjs/coordination'

// Create driver
let driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

// Create coordination client
let client = coordination(driver)

// Create a coordination node
await client.createNode('/local/my-coordination-node')

// Create a session
let session = await client.session('/local/my-coordination-node', {
  timeoutMillis: 10000,
  description: 'My application session',
})

// Or with timeout for session creation
let sessionWithTimeout = await client.session(
  '/local/my-coordination-node',
  { timeoutMillis: 10000 },
  AbortSignal.timeout(5000) // 5 second timeout for session creation
)

// Work with semaphores
await session.createSemaphore({ name: 'my-semaphore', limit: 1 })
await session.acquireSemaphore({ name: 'my-semaphore', count: 1 })
await session.releaseSemaphore({ name: 'my-semaphore' })
await session.deleteSemaphore({ name: 'my-semaphore' })

// Close session
await session.close()
```

### Automatic Resource Management

```typescript
// Session and lock are automatically cleaned up
await using session = await client.session('/local/my-coordination-node')

await session.createSemaphore({ name: 'my-lock', limit: 1 })

{
  await using lock = await session.acquireSemaphore({ name: 'my-lock' })
  if (lock.acquired) {
    // Critical section - lock is held
  }
  // Lock automatically released here
}

// Session automatically closed here
```

## Session Events

Sessions extend `EventEmitter` and emit events for semaphore changes:

```typescript
import { CoordinationSessionEvents } from '@ydbjs/coordination'

// Emitted when a watched semaphore changes
session.on(CoordinationSessionEvents.SEMAPHORE_CHANGED, (event) => {
  console.log(`Semaphore ${event.name} changed`)
  if (event.dataChanged) console.log('Data changed')
  if (event.ownersChanged) console.log('Owners changed')
})

// Emitted when session expires and new session is created
// Important: All acquired semaphores are automatically released by the server
session.on(CoordinationSessionEvents.SESSION_EXPIRED, (event) => {
  console.log(`Session ${event.sessionId} expired at ${event.timestamp}`)
  // Re-acquire semaphores if needed
})
```

## Session Management

The coordination session implements automatic keep-alive and reconnection:

- **Keep-alive**: Automatically responds to server ping messages to maintain the session
- **Reconnection**: Automatically reconnects and retries pending requests if connection is lost
- **Session Recovery**: Preserves session ID across reconnections when possible
- **Session Expiration**: If the session expires on the server (e.g., due to timeout), the client automatically creates a new session with a new ID. When this happens:
  - The `SESSION_EXPIRED` event is emitted with the old session ID
  - All acquired semaphores are automatically released by the server
  - Your application must re-acquire any needed semaphores after receiving this event
- **Graceful Shutdown**: Properly closes streams and rejects pending requests on close

## Examples

See [`tests/examples.test.ts`](./tests/examples.test.ts) for complete working examples including:

- **Leader Election**: Multiple instances competing for leadership with automatic failover
- **Service Discovery**: Dynamic service registration and discovery with automatic cleanup
- **Configuration Publication**: Real-time configuration updates across all instances

## Documentation

For more information about YDB coordination nodes and semaphores, see:

- [YDB Coordination Documentation](https://ydb.tech/docs/ru/reference/ydb-sdk/coordination)
- [Leader Election Recipe](https://ydb.tech/docs/ru/recipes/ydb-sdk/leader-election)
- [Service Discovery Recipe](https://ydb.tech/docs/ru/recipes/ydb-sdk/service-discovery)
- [Configuration Publication Recipe](https://ydb.tech/docs/ru/recipes/ydb-sdk/config-publication)

## License

Apache-2.0
