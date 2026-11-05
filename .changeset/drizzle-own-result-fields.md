---
'@ydbjs/drizzle-adapter': major
---

Return mapped result rows and nested selection groups as objects with a null prototype. Selected fields named `__proto__`, `constructor`, and `toString` remain own properties. Use `Object.hasOwn(row, name)` instead of inherited methods such as `row.hasOwnProperty(name)`; spread a result into `{ ...row }` when an object with `Object.prototype` is required.

Ignore inherited properties in object-row lookup and nullable-join metadata while retaining positional fallback for absent fields and preserving own `null` and `undefined` values.
