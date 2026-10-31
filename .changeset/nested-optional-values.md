---
'@ydbjs/value': patch
---

Preserve the presence of outer Optional values when an inner Optional is null. Encode the required nested_value wrapper and unwrap the corresponding level when decoding query results, instead of returning a protobuf object as a native scalar.

Preserve struct members such as `__proto__` as own data properties, and apply the same own-field rule to single objects and lists of objects.
