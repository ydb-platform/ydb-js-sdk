# YDB JavaScript SDK

Modern, modular SDK for YDB in TypeScript/JavaScript.

- Type‑safe YQL queries with tagged templates
- Automatic parameter binding and transactions
- Rich value/type system with `@ydbjs/value`
- Clear errors, retries, and diagnostics

## Other versions

- [v5](https://github.com/ydb-platform/ydb-js-sdk/tree/v5)
- [v4](https://github.com/ydb-platform/ydb-js-sdk/tree/v4.7.0)

---

## Packages

- [`@ydbjs/core`](./packages/core): Core connection and utilities
- [`@ydbjs/query`](./packages/query): YQL queries, transactions, parameters
- [`@ydbjs/value`](./packages/value): YDB types and values
- [`@ydbjs/api`](./packages/api): gRPC/Protobuf service definitions
- [`@ydbjs/error`](./packages/error): YDB error handling
- [`@ydbjs/auth`](./packages/auth): Authentication (tokens, anonymous, metadata)
- [`@ydbjs/retry`](./packages/retry): Flexible retry policies

---

## Quick Start

### 1) Install

```sh
npm install @ydbjs/core @ydbjs/query
```

### 2) Connect and Query

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const sql = query(driver)
const resultSets = await sql`SELECT 1 + 1 AS sum`
console.log(resultSets) // [ [ { sum: 2 } ] ]
```

---

## Documentation

- [@ydbjs/core](./packages/core/README.md)
- [@ydbjs/query](./packages/query/README.md)
- [@ydbjs/value](./packages/value/README.md)
- [@ydbjs/api](./packages/api/README.md)
- [@ydbjs/error](./packages/error/README.md)
- [@ydbjs/auth](./packages/auth/README.md)
- [@ydbjs/retry](./packages/retry/README.md)

Project docs:

- [Releasing](./RELEASING.md)
- [Versioning](./VERSIONING.md)
- [Contributing](./CONTRIBUTING.md)

---

## Examples

Examples

- Parameterized query:

```ts
import { Int64, Optional, PrimitiveType } from '@ydbjs/value'
const sql = query(driver)
await sql`SELECT ${new Optional(new Int64(100n), new PrimitiveType('INT64'))};`
```

– Transactions:

```ts
await sql.begin(async (tx, signal) => {
  await tx`INSERT INTO users (id, name) VALUES (1, 'Alice')`
  await tx`UPDATE users SET name = 'Bob' WHERE id = 1`
})
```

– Error handling:

```ts
import { YdbError } from '@ydbjs/error'
try {
  await sql`SELECT * FROM non_existent_table`
} catch (e) {
  if (e instanceof YdbError) {
    console.error('YDB Error:', e.message)
  }
}
```

---

## AI Assistant Configuration

For projects using YDB SDK, you can configure AI assistants (GitHub Copilot, Cursor, etc.) to generate secure YQL code.

Multiple example configuration files are provided in `packages/query/ai-instructions/`:

- `.cursorrules.example` - Cursor AI instructions
- `.instructions.example.md` - General AI assistant guidelines
- `.copilot-instructions.example.md` - GitHub Copilot specific
- `.ai-instructions.example.md` - Alternative general format

Copy the appropriate file to your project root to enable secure AI code generation that follows YDB security best practices.

---

## FAQ

- **Add a new service?** Use `@ydbjs/api` for gRPC definitions.
- **Work with YDB types?** Use `@ydbjs/value`.
- **Implement retries?** Use `@ydbjs/retry`.
- **More examples?** See package docs and [GitHub Examples](https://github.com/ydb-platform/ydb-js-sdk/tree/main/examples).

---

## Developer Guide

- Build: `npm run build`
- Test (all): `npm test`
- Lint: `npm run lint`
