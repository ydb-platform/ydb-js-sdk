---
title: Query — Security
---

# Security in Query

Key recommendations for securing YQL queries in `@ydbjs/query`.

## Injection and parameters

- Bind values separately from SQL through `sql\`... ${value} ...\``or the parameter object in`session.execute(text, parameters)`.
- Do not concatenate user input into query strings.

```ts
await sql`SELECT * FROM users WHERE id = ${userId}` // safe
```

## Dynamic identifiers

- Use `identifier(name)` for table/column names.
- Use `unsafe(sql)` only for trusted fragments; never pass user input there.

## Null/undefined

- For an absent value with a known type, use `Optional` from `@ydbjs/value/optional`, for example `new Optional(null, new Int32Type())`.
- The template rejects bare `null` and `undefined`; a named `null` parameter means YDB `Null`, not a typed absent Optional.
- `.parameter(name, undefined)` removes a binding; `undefined` in an `execute()` parameter object is rejected.

## Limits and validation

- Clamp `LIMIT/OFFSET` values and validate all inputs.

## References

- Full guide: `packages/query/SECURITY.md` in the repo.
