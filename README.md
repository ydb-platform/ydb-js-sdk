# YDB JavaScript SDK (`ydb-sdk`)

The `ydb-sdk` SDK provides a comprehensive set of tools for interacting with Yandex Database (YDB) in JavaScript/TypeScript. It is modular, allowing developers to use only the parts they need, and supports a wide range of YDB features, including query execution, value manipulation, error handling, and more.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Packages Overview](#packages-overview)
    - [Core](#core)
    - [Query](#query)
    - [Value](#value)
    - [API](#api)
    - [Error](#error)
- [Quick Start](#quick-start)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)
- [Links](#links)

---

## Features

- Modular design with multiple packages for specific use cases.
- Support for YQL queries with parameterized and type-safe bindings.
- Utilities for encoding/decoding YDB values.
- Comprehensive error handling.
- TypeScript support for type safety and autocompletion.
- Integration with YDB features like transactions, scripting, and monitoring.

---

## Installation

Install the required packages using npm:

```sh
npm install @ydbjs/core @ydbjs/query @ydbjs/value @ydbjs/api @ydbjs/error
```

---

## Packages Overview

### Core

The `@ydbjs/core` package provides foundational utilities for interacting with YDB services. It includes the `Driver` class for managing connections and debugging utilities.

#### Features:
- Connection management.
- Debugging utilities.

#### Example:
```ts
import { Driver } from '@ydbjs/core';

const driver = new Driver('grpc://localhost:2136/local');
await driver.ready();
```

---

### Query

The `@ydbjs/query` package provides a client for executing YQL queries. It supports parameterized queries, transactions, and result handling.

#### Features:
- Tagged template syntax for queries.
- Type-safe parameter binding.
- Query statistics.

#### Example:
```ts
import { query } from '@ydbjs/query';

const sql = query(driver);
const resultSets = await sql`SELECT 1 + 1 AS sum`;
console.log(resultSets); // [ [ { sum: 2 } ] ]
```

---

### Value

The `@ydbjs/value` package provides utilities for working with YDB values and types. It includes functions for encoding/decoding YDB values to/from JavaScript types.

#### Features:
- Encode JavaScript values to YDB types.
- Decode YDB values to JavaScript types.

#### Example:
```ts
import { fromJs, toJs } from '@ydbjs/value';

const ydbValue = fromJs({ key: 'value' });
const jsValue = toJs(ydbValue);
```

---

### API

The `@ydbjs/api` package provides low-level access to YDB APIs, including table, query, scripting, and monitoring services.

#### Features:
- Direct access to YDB gRPC APIs.
- Auto-generated TypeScript types for YDB messages.

#### Example:
```ts
import { TableServiceDefinition } from '@ydbjs/api/table';

const tableService = driver.createClient(TableServiceDefinition);
await tableService.createTable({ ... });
```

---

### Error

The `@ydbjs/error` package provides utilities for handling YDB-specific errors.

#### Features:
- Error classification.
- Detailed error messages.

#### Example:
```ts
import { YdbError } from '@ydbjs/error';

try {
    await sql`SELECT * FROM non_existent_table`;
} catch (error) {
    if (error instanceof YdbError) {
        console.error('YDB Error:', error.message);
    }
}
```

---

## Quick Start

```ts
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';

const driver = new Driver('grpc://localhost:2136/local');
await driver.ready();

const sql = query(driver);
const resultSets = await sql`SELECT 1 + 1 AS sum`;
console.log(resultSets); // [ [ { sum: 2 } ] ]
```

---

## Development

### Building

To build the SDK:

```sh
npm run build
```

### Testing

To run tests:

```sh
npm test
```

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bugfix.
3. Commit your changes with clear messages.
4. Submit a pull request.

---

## License

This project is licensed under the [Apache 2.0 License](LICENSE).

---

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/yandex-cloud/ydb-js-sdk)
- [Issues](https://github.com/yandex-cloud/ydb-js-sdk/issues)
