---
'@ydbjs/value': patch
---

Preserve declared schemas when decoding supported values, including nested Optional presence, typed empty and nullable containers, Struct member order and UUID bits. Reject incompatible schemas and malformed wire values before silently losing data. Apply the same value classification inside arrays as for standalone values.

Preserve scalar values without an unambiguous native representation as typed SDK Values. Variant results require raw mode.
