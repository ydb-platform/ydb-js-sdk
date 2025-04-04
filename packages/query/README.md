# YDB Query Client for JavaScript/TypeScript

The @ydbjs/query package provides a client for executing queries against a YDB database. It offers a convenient API for running YQL statements with support for transactions, parameters, and result handling.

### Features

- ✅ Tagged template syntax for queries
- ✅ Type-safe parameter binding
- ⏳ Transaction support
- ✅ Query statistics
- ⏳ Examples

## Installation

```sh
npm install @ydbjs/core@6.0.0-alpha.1 # Driver
npm install @ydbjs/query@6.0.0-alpha.1 # Query Client
```

## Quick Start

```ts
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';

// Initialize YDB driver
const driver = new Driver('grpc://localhost:2136/local');
await driver.ready();

// Create query client
const sql = query(driver)

// Execute a simple query
const resultSets = await sql`SELECT 1 + 1 AS sum`;
console.log(resultSets); // [ [ { sum: 2 } ] ]
```

## Basic Usage

### Simple Queries

```ts
// Execute a query that returns data
const resultSets = await sql`SELECT 1 AS one, 2 AS two`;
console.log(resultSets); // [ [ { one: 1, two: 2 } ] ]

// Execute a DDL statement
await sql`
  CREATE TABLE users (
    id Uint64,
    name Utf8,
    PRIMARY KEY (id)
  )
`;

// Execute a DML statement
await sql`
  INSERT INTO users (id, name)
  VALUES (1, "Alice"), (2, "Bob")
`;
```

### Parameterized Queries
Parameters can be passed directly in the template, and they'll be automatically converted to the appropriate YDB types:
 - `null` (converted to `Ydb.Null`)
 - `boolean` (converted to `Ydb.Bool`)
 - `number` (converted to `Ydb.Int32`)
 - `bigint` (converted to `Ydb.Int64`)
 - `string` (converted to `Ydb.Text`)
 - `Date` (converted to `Ydb.Datetime`)
 - `TZDate` (converted to `Ydb.TzDatetime`)
 - `Uint8Array` (converted to `Ydb.Bytes`)
 - `Array` (converted to `Ydb.List`)
 - `Set` (converted to `Ydb.Tuple`)
 - `Map` (converted to `Ydb.Dict`)
 - `Object` (converted to `Ydb.Struct`)
 - `Array<Object>` (converted to `Ydb.List<Ydb.Struct<...>`)

```ts
const userId = 42n;
const userName = "Alice";

// Parameters are automatically bound
await sql`
  SELECT * FROM users
  WHERE id = ${userId} AND name = ${userName}
`;

// Explicit parameter declaration
await sql`
  SELECT * FROM users
  WHERE id = $id
`.parameter('id', new Int64(100n));


// Complex parameters are also supported
const users = [
  { id: 1n, name: "Alice" },
  { id: 2n, name: "Bob" }
];

await sql`
  INSERT INTO users
  SELECT * FROM AS_TABLE(${users})
`;

// Typed parameters
import * as Ydb from "@ydbjs/api/value";
import { PrimitiveType } from '@ydbjs/value/primitive'
import { Optional } from '@ydbjs/value/optional'

await sql`SELECT ${new Optional(null, new PrimitiveType(Ydb.Type_PrimitiveTypeId.INT8))};` // [ [ { column0: null } ] ]
await sql`SELECT ${new Optional(new Int64(100n), new PrimitiveType(Ydb.Type_PrimitiveTypeId.INT64))};` // [ [ { column0: 100n } ] ]
```
