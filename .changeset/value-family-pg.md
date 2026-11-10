---
'@ydbjs/value': major
'@ydbjs/query': major
---

Remove PostgreSQL Value types and the `@ydbjs/value/pg` entry point. Decoding a PostgreSQL schema now fails explicitly, including inside empty containers and absent Optionals. Query parameters reject PostgreSQL schemas, including custom Values. Query raw mode continues to return the wire values and type descriptors.
