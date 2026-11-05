---
'@ydbjs/core': patch
---

Retain driver diagnostic channels across driver lifetimes and garbage collection. Discovery, connection and lifecycle subscribers remain connected when subscribing after earlier unobserved publications, including on Bun.
