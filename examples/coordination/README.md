# Coordination Example

This example demonstrates how to use the `@ydbjs/coordination` package to work with YDB coordination nodes and sessions.

## What This Example Shows

- Creating a coordination node
- Describing a coordination node
- Creating a coordination session
- Closing a session
- Dropping a coordination node

## Prerequisites

- Node.js >= 20.19
- Running YDB instance (local or remote)

## Running the Example

1. Make sure you have a running YDB instance:

2. Install dependencies (from the repository root):

```bash
npm install
```

3. Build the packages:

```bash
npm run build
```

4. Run the example:

```bash
cd examples/coordination
npm start
```

Or with custom endpoint and database:

```bash
YDB_ENDPOINT=grpc://localhost:2136 YDB_DATABASE=/local npm start
```

## Expected Output

```
YDB Coordination Example
========================

1. Creating coordination node...
✓ Coordination node created: /local/coordination-example

2. Describing coordination node...
✓ Node info: { ... }

3. Creating coordination session...
✓ Session created with ID: 1

4. Session operations...
   Session ID: 1
   Is closed: false

5. Semaphore operations...
   ✓ Created semaphore 'example-lock' with limit 1
   ✓ Acquired semaphore 'example-lock'
   ✓ Released semaphore 'example-lock'
   ✓ Deleted semaphore 'example-lock'

6. Closing session...
✓ Session closed

7. Cleaning up - dropping coordination node...
✓ Coordination node dropped: /local/coordination-example

Example completed successfully!
```

## Learn More

- [YDB Coordination Documentation](https://ydb.tech/docs/ru/reference/ydb-sdk/coordination)
- [@ydbjs/coordination Package](../../packages/coordination)
