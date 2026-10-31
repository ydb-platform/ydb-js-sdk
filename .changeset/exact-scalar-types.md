---
'@ydbjs/value': minor
---

Expose exact Decimal and empty-value constructors, add named wide date/time and DyNumber constructors, and support the three extended timezone primitive IDs returned by YDB. Accept exact temporal units and timezone text without losing microseconds; preserve the existing native Date/TZDate projection precision and validate server ranges.
