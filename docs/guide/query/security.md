---
title: Query — Security
---

# Security in Query

Key recommendations for securing YQL queries in `@ydbjs/query`.

## Injection and parameters

- Always use the client’s tagged template: `sql\`... ${value} ...\`` — values are parameterized automatically.
- Do not concatenate user input into query strings.

```ts
await sql`SELECT * FROM users WHERE id = ${userId}` // safe
```

## Dynamic identifiers

- Use `identifier(name)` for table/column names.
- Use `unsafe(sql)` only for trusted fragments; never pass user input there.

## Null/undefined

- Use Optional types from `@ydbjs/value` explicitly for nullable fields.

## Limits and validation

- Clamp `LIMIT/OFFSET` values and validate all inputs.

## References

- Full guide: `packages/query/SECURITY.md` in the repo.
