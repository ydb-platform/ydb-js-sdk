---
'@ydbjs/drizzle-adapter': major
---

Execute Drizzle statements with named parameters through the native QueryClient. Pass a shared client to `drizzle(client)`, `drizzle({ client, schema })`, or `new YdbDriver(client)` to reuse its pool and decoding options. The caller owns the shared client.

`YdbDriver.client` now returns the underlying QueryClient and is read-only. Replace assignments of a tagged SQLClient with constructor injection. Use `db.transaction()` for Drizzle transactions previously established through a tagged client's `sql.begin()`. Standalone Drizzle statements now own their retry scope, including when called inside a tagged client's `sql.do()`, and read current parameter types and values on each attempt.

Retry the whole Drizzle transaction on eligible statement failures, preserve the terminal Drizzle error, and require an explicit `idempotent: true` to replay after an uncertain outcome, including for read-only transactions. Drizzle renders JavaScript `null` in generated queries as the YQL constant `NULL` and binds the remaining values as named parameters.
