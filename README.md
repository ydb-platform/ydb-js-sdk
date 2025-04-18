# YDB JavaScript SDK

A modular, modern SDK for working with YDB in JavaScript/TypeScript. Supports queries, transactions, types, error handling, authentication, and more.

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

## Installation

```sh
npm install @ydbjs/core @ydbjs/query @ydbjs/value @ydbjs/api @ydbjs/error
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

---

## Examples

**Parameterized Query:**

```ts
import { Int64, Optional, PrimitiveType } from '@ydbjs/value'
const sql = query(driver)
await sql`SELECT ${new Optional(new Int64(100n), new PrimitiveType('INT64'))};`
```

**Transactions:**

```ts
await sql.begin(async (tx, signal) => {
  await tx`INSERT INTO users (id, name) VALUES (1, 'Alice')`
  await tx`UPDATE users SET name = 'Bob' WHERE id = 1`
})
```

**Error Handling:**

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

## FAQ

- **Add a new service?** Use `@ydbjs/api` for gRPC definitions.
- **Work with YDB types?** Use `@ydbjs/value`.
- **Implement retries?** Use `@ydbjs/retry`.
- **More examples?** See package docs and [GitHub Examples](https://github.com/yandex-cloud/ydb-js-sdk/tree/main/examples).

---

## Developer Guide

- Build all packages: `npm run build`
- Run all tests: `npm test`
- Build a single package: `cd packages/query && npm run build`
- Generate gRPC/protobuf files (for @ydbjs/api): `cd packages/api && npm run generate`

Devcontainer setup includes YDB and Prometheus for local development. See `.devcontainer/` for details.

---

## Contributing

Contributions are welcome! Open issues, submit PRs, and discuss ideas.

---

## License

Licensed under [Apache 2.0](LICENSE).

---

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
