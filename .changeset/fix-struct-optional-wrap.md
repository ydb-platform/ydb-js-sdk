---
'@ydbjs/value': patch
---

Fix Struct constructor double-wrapping fields declared as Optional

When a type definition was provided, the constructor wrapped every field in `Optional` regardless of the value's actual type. For fields declared `Optional<T>` with a concrete value already of type `T`, this produced `Optional<Optional<T>>` and caused encoding mismatches against the declared struct type.

The constructor now only wraps `null` in `Optional` (using the declared item type); values are passed through unchanged. Missing values for non-`Optional` fields now throw instead of silently becoming `Optional(null)`.
