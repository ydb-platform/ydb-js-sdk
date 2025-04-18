# @ydbjs/query

The `@ydbjs/query` package provides a client for executing queries against a YDB database. It offers a convenient API for running YQL statements with support for transactions, parameters, and result handling.

## Features

- Tagged template syntax for queries
- Type-safe parameter binding
- Transaction support
- Query statistics

## Installation

Install the package and its peer dependency:

```sh
npm install @ydbjs/core@alpha @ydbjs/query@alpha
```

## Usage

### Quick Start

```ts
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';

const driver = new Driver('grpc://localhost:2136/local');
await driver.ready();

const sql = query(driver);
const resultSets = await sql`SELECT 1 + 1 AS sum`;
console.log(resultSets); // [ [ { sum: 2 } ] ]
```

### Parameterized Queries

```ts
const userId = 42n;
const userName = "Alice";
await sql`
  SELECT * FROM users
  WHERE id = ${userId} AND name = ${userName}
`;
```

### Transactions

```ts
const result = await sql.begin(async (tx) => {
  const users = await tx`SELECT * FROM users WHERE active = true`;
  await tx`UPDATE users SET last_login = CurrentUtcTimestamp() WHERE active = true`;
  return users;
});
```

## Development

### Building the Package

```sh
npm run build
```

### Running Tests

```sh
npm test
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
