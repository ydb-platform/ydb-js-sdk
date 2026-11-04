---
'@ydbjs/value': patch
---

Validate primitive JavaScript payload types and scalar ranges in Value construction, including values decoded from protobuf. Reject implicit boolean, numeric, string and byte-array coercions before encoding; preserve valid floating-point special values and UUID words.

Remove repeated checks from numeric wrappers and native result projection. Keep precision checks before conversions that could lose information.
