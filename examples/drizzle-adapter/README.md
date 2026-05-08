# YDB Drizzle Adapter Example

Small TypeScript CLI example for `@ydbjs/drizzle-adapter`.

For the larger interactive UI with generated YQL, action catalog, traces, and DDL previews, use [`examples/drizzle-adapter-lab`](../drizzle-adapter-lab/).

## What It Demonstrates

- Schema declarations with `ydbTable()`.
- Relations with `relations()`, `one()`, and `many()`.
- Inline migrations with `migrate()`.
- CRUD through `insert`, `upsert`, `update`, and `delete`.
- Joins, expanded `db.query.*` relational queries, raw execution helpers, `$count`, and transactions.
- Relation entry points from projects, tasks, and users with nested `with`, `where`, and `orderBy`.
- Correct driver shutdown through `db.$client.close()`.

## Run

Start a local YDB instance first. From the repository root you can use the manual setup from [`examples/README.MD`](../README.MD), then run:

```bash
cd examples/drizzle-adapter
npm install
npm start
```

By default the example uses:

```text
grpc://localhost:2136/local
```

Override it with `YDB_CONNECTION_STRING` if needed.
