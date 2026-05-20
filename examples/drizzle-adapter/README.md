# YDB Drizzle Adapter Example

Small TypeScript CLI example for `@ydbjs/drizzle-adapter`.

## What It Demonstrates

- Schema declarations with `ydbTable()` using a composite primary key `(hash, id)`, where `hash` is filled server-side via `Digest::NumericHash(CAST(id AS Uint64))` so consecutive ids spread across tablets instead of hot-spotting the "last" partition.
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
