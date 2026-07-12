---
'@ydbjs/topic': patch
---

The built-in ZSTD codec no longer crashes with a bare `TypeError` on runtimes where `node:zlib` has no zstd support (Node.js before 22.15 / 23.8). `getCodec(Codec.ZSTD)` and `ZSTD_CODEC` now throw an actionable error naming the required Node.js versions, the default reader codec map registers ZSTD only when the runtime supports it, and a reader that receives ZSTD data on an older runtime fails with the register-it-in-`codecMap` error instead.
