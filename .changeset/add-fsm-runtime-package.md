---
'@ydbjs/fsm': minor
---

Add new `@ydbjs/fsm` runtime package for async-first finite state machines in YDB JS SDK.

- Introduce reusable runtime with single-writer event processing
- Support typed transitions and effect handler maps
- Add async source ingestion and runtime output as `AsyncIterable`
- Add lifecycle controls: `close` (graceful) and `destroy` (hard shutdown)
- Add package tests, design document, and runnable example in `examples/fsm`
