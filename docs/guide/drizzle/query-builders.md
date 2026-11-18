---
title: Drizzle Adapter — Query Builders
---

# Query Builders

The YDB Drizzle adapter extends the standard Drizzle syntax to support YDB-specific features and YQL-native operators.

For end-to-end examples that combine these builders, see [Drizzle Adapter Examples](/guide/drizzle/examples).

## SELECT Builder

The `YdbSelectBuilder` is the primary tool for data fetching.

### Entry Points

```ts
db.select() // SELECT *
db.select({ id: users.id, name: users.name }) // Specific columns
db.selectDistinct({ name: users.name }) // SELECT DISTINCT
db.selectDistinctOn([users.name], { id: users.id }) // SELECT DISTINCT ON (...)
```

### Fluent API & YDB Extensions

In addition to standard Drizzle methods (`where`, `orderBy`, `limit`, etc.), the adapter provides:

- `.fromAsTable(binding, alias?)`: Use `AS_TABLE` source.
- `.fromValues(rows, options?)`: Use inline values as a source.
- `.without(...columns)`: Exclude specific columns from `SELECT *`.
- `.groupCompactBy(...columns)`: Optimized grouping for pre-sorted inputs.
- `.assumeOrderBy(...columns)`: Optimizer hint that the input is already sorted.
- `.sample(ratio)` / `.tableSample(method, size)`: Random row sampling.
- `.window(name, definition)`: Named window definitions.
- `.intoResult(name)`: Direct output to a named YDB result block.
- `.flattenBy()`, `.flattenListBy()`: YQL `FLATTEN` operators.

Example:

```ts
let rows = await db
  .select()
  .from(users)
  .without(users.password)
  .where(eq(users.active, true))
  .limit(10)
  .execute()
```

## JOINs

The adapter supports 10 join types, including YDB-specific semi-joins:

| Standard JOINs | YDB Semi-JOINs                                                 |
| :------------- | :------------------------------------------------------------- |
| `.innerJoin()` | `.leftSemiJoin()`: Left rows with matches in right.            |
| `.leftJoin()`  | `.rightSemiJoin()`: Right rows with matches in left.           |
| `.rightJoin()` | `.leftOnlyJoin()`: Left rows **without** matches (NOT EXISTS). |
| `.fullJoin()`  | `.rightOnlyJoin()`: Right rows **without** matches.            |
| `.crossJoin()` | `.exclusionJoin()`: Rows without a match in the other table.   |

```ts
let inactiveUsers = await db
  .select()
  .from(users)
  .leftOnlyJoin(posts, eq(users.id, posts.authorId))
  .execute()
```

## Mutations

### INSERT, UPSERT, and REPLACE

YDB provides efficient ways to manage data by primary key.

- `.insert(table)`: Standard `INSERT INTO`.
- `.upsert(table)`: `UPSERT INTO` — the most efficient "insert or update" by PK.
- `.replace(table)`: `REPLACE INTO` — fully replaces the row by PK; columns omitted from `.values()` are rendered as `DEFAULT`.

```ts
await db.upsert(users).values({ id: 1, name: 'Alice' }).execute()
await db.replace(users).values({ id: 1, name: 'Replaced' }).execute()
```

Use `upsert()` when a retryable writer should create a row or update only the provided columns:

```ts
await db
  .upsert(users)
  .values({
    id: 42,
    name: 'Ada',
    updatedAt: new Date(),
  })
  .execute()
```

Use `replace()` when the row is a complete snapshot and defaults for omitted columns are intentional:

```ts
await db
  .replace(users)
  .values({
    id: 42,
    name: 'Ada Lovelace',
    updatedAt: new Date(),
  })
  .execute()
```

### UPDATE and DELETE

- `.update(table)`: Partial column updates.
- `.delete(table)`: Row deletion.

The adapter also supports **Update with Subquery** (`.on()`) and **Delete with USING**:

```ts
await db
  .update(users)
  .on((qb) =>
    qb
      .select({ id: users.id, name: sql`'New Name'`.as('name') })
      .from(users)
      .where(eq(users.status, 'active'))
  )
  .execute()
```

## CTE ($with)

Common Table Expressions in YDB are rendered as variable bindings.

```ts
let activeUsers = db.$with('active_users').as(db.select().from(users).where(eq(users.active, true)))

let rows = await db.with(activeUsers).select().from(activeUsers).execute()
```

## Prepared Queries

`.prepare()` creates a reusable query object containing the rendered YQL and values already supplied to the builder. Its execution methods accept no parameters; build another query to use different values. Named placeholders and server-side prepared statements are not supported.

The optional name accepted by `prepare(name?)` is currently ignored.

```ts
let selectUser = db.select().from(users).where(eq(users.id, 1)).prepare()

let user = await selectUser.execute()
```

Builders execute with `.execute()`. Prepared queries also expose `.all()`, `.get()`, and `.values()`.

```ts
let prepared = db.select({ id: users.id, name: users.name }).from(users).prepare()

let rows = await prepared.all()
let first = await prepared.get()
let values = await prepared.values()
```
